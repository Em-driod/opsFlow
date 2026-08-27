import type { Request, Response, NextFunction } from 'express';

export type Role = 'admin' | 'staff';

/**
 * Role gate. Must run *after* `protect`, which populates `req.user`.
 *
 * Returns 403 (authenticated, but this role may not perform the action) rather
 * than 401, so the client can tell "log in again" apart from "ask an admin".
 *
 *   router.delete('/:id', protect, permit('admin'), deleteThing)
 */
export const permit =
  (...allowedRoles: Role[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'Not authorized, no session' });
      return;
    }
    if (!allowedRoles.includes(req.user.role as Role)) {
      res.status(403).json({
        message:
          allowedRoles.length === 1 && allowedRoles[0] === 'admin'
            ? 'This action is restricted to admins.'
            : `This action requires one of these roles: ${allowedRoles.join(', ')}.`,
      });
      return;
    }
    next();
  };

/** Convenience alias for the common case. */
export const adminOnly = permit('admin');
