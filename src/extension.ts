import * as vscode from 'vscode';
import { FileVersionDB } from './db';
import { initializeDatabase } from './db/schema';
import { VersionTreeProvider, exportVersionToFile, viewVersion, registerVersionProvider, appendVersionToFile, initializeProviders } from './versionTreeProvider';
import { VersionRecord } from './db/schema';
import { VersionTreeItem } from './versionTreeProvider';
import { SettingsManager } from './settings';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createPatch } from 'diff';

const execAsync = promisify(exec);

let fileVersionDB: FileVersionDB;
let versionTreeProvider: VersionTreeProvider;
let settingsManager: SettingsManager;

const lastCommitByRepo = new Map<string, string>();
const stagedChangesMap = new Map<string, { files: Set<string>, message: string }>();

async function getLatestCommitMessage(workspacePath: string): Promise<string> {
	try {
		const { stdout } = await execAsync('git log -1 --pretty=%B', { cwd: workspacePath });
		return stdout.trim();
	} catch (error) {
		console.error('Error getting commit message:', error);
		return '';
	}
}

async function handleGitCommit(workspacePath: string, repository: any, changedFiles: Set<string>, commitMessage?: string) {
	try {
		// Get the commit message if not provided
		if (!commitMessage) {
			commitMessage = await getLatestCommitMessage(workspacePath);
		}
		
		// Skip if no valid commit message
		if (!commitMessage || commitMessage.trim() === '') {
			return;
		}

		// Check if auto-cleanup is enabled
		const autoCleanup = await settingsManager.getAutoCleanupAfterCommit();
		
		// Process each file that was committed
		const allFiles = fileVersionDB.getAllFiles();
		let processedCount = 0;
		
		for (const file of allFiles) {
			const normalizedFilePath = path.normalize(file.file_path);
			
			// Skip files that weren't in this commit
			if (!changedFiles.has(normalizedFilePath)) {
				continue;
			}
			
			const versions = fileVersionDB.getFileVersions(file.id);
			if (versions.length === 0) {
				continue;
			}
			
			// Get the latest version
			const latestVersion = versions[0];
			
			// Create a new version with the commit message marker
			const newContent = `/* Git commit: ${commitMessage} */\n${latestVersion.content}`;
			fileVersionDB.createVersion(file.id, newContent);
			processedCount++;
			
			// If auto-cleanup is enabled, delete previous versions
			if (autoCleanup) {
				for (const version of versions) {
					fileVersionDB.deleteVersion(version.id);
				}
			}
		}
		
		// Refresh the tree view if any files were processed
		if (processedCount > 0) {
			versionTreeProvider.refresh();
			
			const message = autoCleanup 
				? 'Cleaned up versions after git commit'
				: 'Updated versions with git commit information';
				
			await settingsManager.showConditionalInfoMessage(message);
		}
	} catch (error) {
		console.error('Error handling git commit:', error);
	}
}

export async function activate(context: vscode.ExtensionContext) {
	try {
		const db = await initializeDatabase(context);
		fileVersionDB = new FileVersionDB(db, context);
		settingsManager = new SettingsManager(context);
		
		initializeProviders(fileVersionDB, settingsManager);
		
		versionTreeProvider = new VersionTreeProvider(fileVersionDB, settingsManager);
		const treeView = vscode.window.createTreeView('llmcheckpointVersions', {
			treeDataProvider: versionTreeProvider,
			showCollapseAll: false
		});
		versionTreeProvider.setTreeView(treeView);
		versionTreeProvider.setupEditorTracking();

		registerVersionProvider(context);
		
		
		const gitExtension = vscode.extensions.getExtension('vscode.git');
		if (gitExtension) {
			gitExtension.activate().then(exports => {
				const git = exports.getAPI(1);
				
				git.onDidOpenRepository((repository: any) => {
					setupRepositoryWatcher(repository);
				});

				
				const repositories = git.repositories;
				repositories.forEach((repository: any) => {
					setupRepositoryWatcher(repository);
				});
			}).then(undefined, error => {
				console.error('Failed to activate Git extension:', error);
				vscode.window.showErrorMessage('Failed to activate Git extension: ' + error);
			});
		} else {
			const message = 'Git extension not found, commit cleanup will not work';
			vscode.window.showWarningMessage(message);
		}

		const commands = [
			vscode.commands.registerCommand('llmcheckpoint.saveVersion', async () => {
				await saveCurrentVersion();
			}),
			vscode.commands.registerCommand('llmcheckpoint.showVersionHistory', showVersionHistory),
			vscode.commands.registerCommand('llmcheckpoint.viewVersion', (version) => {
				return viewVersion(version, fileVersionDB);
			}),
			vscode.commands.registerCommand('llmcheckpoint.exportVersion', (item: VersionTreeItem) => {
				if (item.version) {
					exportVersion(item.version);
				} else {
					vscode.window.showErrorMessage('No version information found');
				}
			}),
			vscode.commands.registerCommand('llmcheckpoint.deleteVersion', (item: VersionTreeItem) => {
				if (item.version) {
					deleteVersion(item.version);
				}
			}),
			vscode.commands.registerCommand('llmcheckpoint.openSettings', () => {
				settingsManager.showSettingsUI();
			}),
			vscode.commands.registerCommand('llmcheckpoint.appendVersion', (item: VersionTreeItem) => {
				if (item.version) {
					appendVersion(item.version);
				} else {
					vscode.window.showErrorMessage('No version information found');
				}
			}),
			vscode.commands.registerCommand('llmcheckpoint.quickClean', async () => {
				const result = await vscode.window.showWarningMessage(
					'This will keep only the latest version of each file and delete all older versions. This action cannot be undone.',
					{ modal: true },
					'Yes'
				);
				if (result === 'Yes') {
					const files = fileVersionDB.getAllFiles();
					for (const file of files) {
						const versions = fileVersionDB.getFileVersions(file.id);
						if (versions.length > 1) {
							
							for (let i = 1; i < versions.length; i++) {
								fileVersionDB.deleteVersion(versions[i].id);
							}
						}
					}
					versionTreeProvider.refresh();
					await settingsManager.showConditionalInfoMessage('Kept only latest versions');
				}
			}),
			vscode.commands.registerCommand('llmcheckpoint.clearAll', async () => {
				const result = await vscode.window.showWarningMessage(
					'Are you sure you want to delete all versions? This cannot be undone.',
					{ modal: true },
					'Yes'
				);
				if (result === 'Yes') {
					const files = fileVersionDB.getAllFiles();
					for (const file of files) {
						const versions = fileVersionDB.getFileVersions(file.id);
						for (const version of versions) {
							fileVersionDB.deleteVersion(version.id);
						}
					}
					versionTreeProvider.refresh();
					await settingsManager.showConditionalInfoMessage('All versions cleared');
				}
			})
		];

		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		
		const onSaveDisposable = vscode.workspace.onWillSaveTextDocument(async (e) => {
			try {
				const relativePath = vscode.workspace.asRelativePath(e.document.uri);
				const content = e.document.getText();

				let file = fileVersionDB.getFile(relativePath);
				if (!file) {
					file = fileVersionDB.createFile(relativePath);
				}

				const saveAllChanges = await settingsManager.getSaveAllChanges();

				const versions = fileVersionDB.getFileVersions(file.id, 1);
				if (versions.length > 0 && versions[0].content === content) {
					return; 
				}

				if (!saveAllChanges) {
					const versions = fileVersionDB.getFileVersions(file.id, 1);
					if (versions.length === 0) {
						const lines = content.split('\n');
						if (lines.length <= 1) {
							return;
						}
					} else {
						const previousContent = versions[0].content;
						const patch = createPatch('file', previousContent, content);
						const changes = patch.split('\n')
							.filter(line => line.startsWith('+') || line.startsWith('-'))
							.filter(line => !line.startsWith('+++') && !line.startsWith('---'));
							
						if (changes.length <= 2) {
							return;
						}
					}
				}
				fileVersionDB.createVersion(file.id, content);
				setTimeout(() => {
					versionTreeProvider.refresh(relativePath);
				}, 100);
			} catch (error) {
				console.error('Error in save handler:', error);
				vscode.window.showErrorMessage(`Error saving version: ${error}`);
			}
		});

		const fileWatcherDisposable = watcher.onDidChange(async (uri) => {
			if (uri.fsPath.endsWith('history_context.txt')) {
				return;
			}

			const openTextDocuments = vscode.workspace.textDocuments;
			if (openTextDocuments.some(doc => doc.uri.toString() === uri.toString())) {
				await handleFileChange(uri);
				versionTreeProvider.refresh();
			}
		});

		
		context.subscriptions.push(
			...commands,
			fileWatcherDisposable,
			onSaveDisposable,
			watcher,
			treeView,
			versionTreeProvider
		);

	} catch (error) {
		console.error('Failed to activate LLM Checkpoint:', error);
		vscode.window.showErrorMessage(`Failed to activate LLM Checkpoint: ${error}`);
		throw error; 
	}
}

async function handleFileChange(uri: vscode.Uri) {
	try {
		versionTreeProvider.refresh();
	} catch (error) {
		console.error('Error handling file change:', error);
	}
}

async function saveCurrentVersion() {
	try {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('No active editor');
			return;
		}

		const document = editor.document;
		if (!document.isDirty) {
			return;
		}

		const relativePath = vscode.workspace.asRelativePath(document.uri);
		const content = document.getText();

		let file = fileVersionDB.getFile(relativePath);
		if (!file) {
			file = fileVersionDB.createFile(relativePath);
		}

		const version = fileVersionDB.createVersion(file.id, content);
		versionTreeProvider.refresh(relativePath);

	} catch (error) {
		console.error('Error saving version:', error);
		vscode.window.showErrorMessage(`Failed to save version: ${error}`);
	}
}

async function showVersionHistory() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor');
		return;
	}

	const document = editor.document;
	const relativePath = vscode.workspace.asRelativePath(document.uri);
	const file = fileVersionDB.getFile(relativePath);
	
	if (!file) {
		vscode.window.showWarningMessage('No version history found for this file');
		return;
	}

	const versions = fileVersionDB.getFileVersions(file.id);
	if (versions.length === 0) {
		vscode.window.showInformationMessage('No versions found for this file');
		return;
	}

	const items = versions.map(v => ({
		label: `Version ${v.version_number}`,
		description: new Date(v.timestamp).toLocaleString(),
		version: v
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a version to view or restore'
	});

	if (selected) {
		const uri = vscode.Uri.file(relativePath);
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc);
		
		const originalContent = selected.version.content;
		const tempUri = uri.with({ scheme: 'untitled', path: `${relativePath}-v${selected.version.version_number}` });
		const tempDoc = await vscode.workspace.openTextDocument(tempUri);
		await vscode.window.showTextDocument(tempDoc, { viewColumn: vscode.ViewColumn.Beside });
		await vscode.window.activeTextEditor?.edit(editBuilder => {
			const fullRange = new vscode.Range(
				tempDoc.positionAt(0),
				tempDoc.positionAt(tempDoc.getText().length)
			);
			editBuilder.replace(fullRange, originalContent);
		});
	}
}

async function exportVersion(version: VersionRecord) {
	try {
		const exportPath = await settingsManager.getHistoryPath();
		await exportVersionToFile(version, exportPath);
	} catch (error: any) {
		console.error('Set context error details:', {
			error: error.message,
			stack: error.stack,
			version: version
		});
		vscode.window.showErrorMessage(`Failed to set new context: ${error.message}`);
	}
}

async function deleteVersion(version: VersionRecord) {
	try {
		const edit = new vscode.WorkspaceEdit();
		fileVersionDB.deleteVersion(version.id);
		versionTreeProvider.refresh();
		await settingsManager.showConditionalInfoMessage('Version deleted successfully');
	} catch (error: any) {
		const errorMessage = error?.message || 'Unknown error occurred';
		vscode.window.showErrorMessage('Failed to delete version: ' + errorMessage);
	}
}

async function appendVersion(version: VersionRecord) {
	try {
		const file = fileVersionDB.getFileById(version.file_id);
		if (!file) {
			throw new Error(`File not found for file_id: ${version.file_id}`);
		}
		
		const exportPath = await settingsManager.getHistoryPath();
		await appendVersionToFile(version, exportPath);
	} catch (error: any) {
		console.error('Append error details:', {
			error: error.message,
			stack: error.stack,
			version: version
		});
		vscode.window.showErrorMessage(`Failed to append version: ${error.message}`);
	}
}

function setupRepositoryWatcher(repository: any) {
	let isProcessingCommit = false;
	
	repository.state.onDidChange(async () => {
		try {
			// Avoid concurrent processing
			if (isProcessingCommit) {
				return;
			}
			
			const head = repository.state.HEAD;
			const commit = head?.commit;
			const repoPath = repository.rootUri.fsPath;
			
			// Skip if no HEAD commit
			if (!commit) {
				return;
			}
			
			// Track staged files
			const stagedFiles: Set<string> = new Set(repository.state.indexChanges.map((change: any) => {
				const absolutePath = change.uri.fsPath;
				return path.normalize(vscode.workspace.asRelativePath(absolutePath));
			}));
			
			stagedChangesMap.set(repoPath, {
				files: stagedFiles,
				message: ''
			});
			
			// Check if a commit just happened
			const lastCommit = lastCommitByRepo.get(repoPath);
			if (lastCommit !== commit) {
				isProcessingCommit = true;
				try {
					// Update the last known commit
					lastCommitByRepo.set(repoPath, commit);
					
					// Get the commit message
					const commitMessage = await getLatestCommitMessage(repoPath);
					if (!commitMessage) {
						return; // Skip if no commit message
					}
					
					// Get the files that were staged before this commit
					const stagedInfo = stagedChangesMap.get(repoPath);
					if (stagedInfo && stagedInfo.files.size > 0) {
						// Process the commit
						await handleGitCommit(repoPath, repository, stagedInfo.files, commitMessage);
						// Clear the staged files after processing
						stagedChangesMap.delete(repoPath);
					}
				} finally {
					isProcessingCommit = false;
				}
			}
		} catch (error) {
			console.error('Error in repository watcher:', error);
			isProcessingCommit = false;
		}
	});
}