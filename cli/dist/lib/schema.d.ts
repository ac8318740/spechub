export interface SchemaDefinition {
    name: string;
    description?: string;
    artifacts: SchemaArtifact[];
    source: 'project' | 'user' | 'package';
    path: string;
}
export interface SchemaArtifact {
    name: string;
    filename: string;
    description?: string;
    required?: boolean;
    template?: string;
}
/**
 * Resolution order: project spechub/schemas/ > user ~/.local/share/spechub/schemas/ > package schemas/
 */
export declare function resolveSchema(name: string, projectRoot?: string): SchemaDefinition | null;
/**
 * List all available schemas across all resolution levels.
 */
export declare function listSchemas(projectRoot?: string): SchemaDefinition[];
