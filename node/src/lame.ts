/**
 * The MP3 encoder the editor makes a song's streaming copy with
 * (manage/src/stream-copy.js), served as a file of its own at LAME_PATH. It
 * is about half the editor, and only needed while uploading, so the editor
 * fetches it then, once, and the browser keeps it. Public, like the icons
 * (studio.ts): it's an open-source library (LGPL-3.0) and says nothing about
 * anyone. Taken from the editor's own copy, so the two can't differ.
 */
// @ts-ignore: esbuild imports it as text; TypeScript has no word for that.
import source from "../../manage/node_modules/@breezystack/lamejs/dist/lamejs.js" with { type: "text" };

export const LAME_JS: string = source;
