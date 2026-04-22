export interface ProjectConfig {
    schema?: string;
    context?: Record<string, string>;
    [key: string]: unknown;
}
/**
 * Find the project root by walking up looking for an spechub/ directory.
 */
export declare function findProjectRoot(from?: string): string | null;
/**
 * Read the project config (spechub/config.yaml).
 */
export declare function readProjectConfig(root: string): ProjectConfig | null;
/**
 * Resolve the spechub directory path from a given root.
 */
export declare function spechubDir(root: string): string;
