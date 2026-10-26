/**
 * Developer-only features (game speed control). True on the dev server and in
 * `npm run build:dev`; false in production builds, where Vite replaces this
 * with a constant and strips the guarded code.
 */
export const DEV_TOOLS = import.meta.env.DEV || import.meta.env.MODE === 'development';
