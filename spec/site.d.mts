// Types for site.mjs, shared by the artist's server and the editor.
export const SITE_VERSION: number;
export const SECTION_TYPES: Record<string, { label: string; hint: string }>;
export const THEMES: Record<string, { label: string; bg: string; bg2: string; ink: string; ink2: string; mut: string; line: string }>;
export const FONTS: Record<string, { label: string; css: string }>;
export interface Site { v: number; look: { theme: string; font: string; accent: string }; hero: { title: string; tagline: string; image: string }; sections: Record<string, unknown>[] }
export function httpsUrl(v: unknown): string;
export function cleanSite(raw: unknown): Site;
export function starterSite(manifest: unknown): Site;
export function newSection(type: string, taken?: string[]): Record<string, unknown>;
export function newItem(type: string): Record<string, unknown>;
export function esc(s: unknown): string;
export function renderSite(site: unknown, manifest: unknown, options?: { edit?: boolean; slots?: { music?: string; footer?: string }; listenUrl?: string }): { css: string; body: string; site: Site };
