import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, b);
}

export interface TokenData {
  githubToken?: string;
  authToken?: string;
}

/**
 * Express middleware gating every /api route behind a shared bearer token
 * (CJW_AUTH_TOKEN). If no token is configured, requests pass through
 * unauthenticated — fine for local/dev use, but every cloud deploy should
 * set CJW_AUTH_TOKEN since this backend can run shell commands and push
 * code on the operator's behalf.
 */
export function requireAuth(authToken: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!authToken) return next();
    const header = req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (provided && safeEqual(provided, authToken)) {
      res.locals.token = { authToken: provided };
      return next();
    }
    res.status(401).json({ error: "Unauthorized" });
  };
}

/** Same check for the WebSocket upgrade, where the token arrives as a query param. */
export function checkWsToken(authToken: string | undefined, provided: string | null): boolean {
  if (!authToken) return true;
  return !!provided && safeEqual(provided, authToken);
}

/** Middleware that adds token data to res.locals if authenticated */
export function withAuth(authToken: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!authToken) {
      res.locals.token = {};
      return next();
    }
    const header = req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (provided && safeEqual(provided, authToken)) {
      res.locals.token = { authToken: provided };
      return next();
    }
    res.status(401).json({ error: "Unauthorized" });
  };
}

/** Middleware that requires a valid token */
export function requireToken(authToken: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!authToken) return next();
    const header = req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (provided && safeEqual(provided, authToken)) {
      res.locals.token = { authToken: provided };
      return next();
    }
    res.status(401).json({ error: "Unauthorized" });
  };
}