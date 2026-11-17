// Vercel's entry point. vercel.json sends /preview/* here; the work is in ../preview.mjs.
import { handle } from "../preview.mjs";

const run = (request) => handle(request, process.env);
export { run as GET, run as POST, run as OPTIONS };
