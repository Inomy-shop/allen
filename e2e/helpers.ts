/**
 * Shared test helpers — reads ports from environment so tests work in both
 * main dev (4023/5173) and workspace sandboxes (15000/15001).
 */

const API_PORT = process.env.API_PORT || process.env.PORT || '4023';
const UI_PORT = process.env.UI_PORT || '5173';

export const API = `http://localhost:${API_PORT}`;
export const UI = `http://localhost:${UI_PORT}`;
