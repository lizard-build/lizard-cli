export interface EmbeddedSkill {
    name: string;
    content: string;
    /** references/<name>.md, keyed by <name> */
    references: Record<string, string>;
}
export declare const EMBEDDED_SKILLS: Record<string, EmbeddedSkill>;
