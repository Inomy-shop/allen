import type { Request } from 'express';

/**
 * Typed request with params for Express 5 compatibility.
 */
export type TypedRequest<P extends Record<string, string> = Record<string, string>> = Request<P>;

/**
 * Safely extract a string param from Express 5 request.
 */
export function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}
