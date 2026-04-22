export declare function ensureDir(path: string): void;
export declare function readYaml<T = unknown>(path: string): T | null;
export declare function readMarkdown(path: string): string | null;
export declare function listChanges(root: string): string[];
export declare function listSpecs(root: string): string[];
export declare function listArchivedChanges(root: string): string[];
export declare function requireProject(root: string | null): asserts root is string;
export declare function formatDate(): string;
