import initSqlJs, { Database } from 'sql.js';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';

export interface FileRecord {
    id: number;
    file_path: string;
    current_version_id: number | null;
}

export interface VersionRecord {
    id: number;
    file_id: number;
    content: string;
    timestamp: string;
    version_number: number;
    label?: string;
}

export async function initializeDatabase(context: vscode.ExtensionContext): Promise<Database> {
    if (!context.globalStorageUri) {
        throw new Error('Global storage URI is not available');
    }
    
    const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'default';
    const workspaceHash = Buffer.from(workspaceId).toString('base64');
    
    const dbPath = path.join(context.globalStorageUri.fsPath, `file_versions.${workspaceHash}.db`);
    
    if (!fs.existsSync(context.globalStorageUri.fsPath)) {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    }

    const SQL = await initSqlJs();
    
    let db: Database;
    
    try {
        if (fs.existsSync(dbPath)) {
            const buffer = fs.readFileSync(dbPath);
            try {
                db = new SQL.Database(buffer);
            } catch (dbError) {
                console.warn(`Database corruption detected. Creating backup and initializing new database.`);
                const backupPath = `${dbPath}.backup.${Date.now()}`;
                fs.copyFileSync(dbPath, backupPath);
                fs.unlinkSync(dbPath);
                db = new SQL.Database();
            }
        } else {
            db = new SQL.Database();
        }

        db.run('PRAGMA foreign_keys = ON');

        db.run(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL UNIQUE,
                current_version_id INTEGER,
                FOREIGN KEY (current_version_id) REFERENCES versions(id)
            )
        `);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                version_number INTEGER NOT NULL,
                label TEXT,
                FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
                UNIQUE(file_id, version_number)
            )
        `);
    //migration
        try {
            db.run(`ALTER TABLE versions ADD COLUMN label TEXT`);
        } catch (error) {
            console.log('Probably already exists');
        }

        db.run(`
            CREATE TABLE IF NOT EXISTS repository_commits (
                repo_path TEXT PRIMARY KEY,
                commit_hash TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_files_path ON files(file_path);
            CREATE INDEX IF NOT EXISTS idx_versions_file_id ON versions(file_id);
            CREATE INDEX IF NOT EXISTS idx_versions_timestamp ON versions(timestamp);
            CREATE INDEX IF NOT EXISTS idx_repo_path ON repository_commits(repo_path);
        `);

        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));

        return db;
    } catch (error) {
        throw new Error('Failed to initialize database');
    }
} 