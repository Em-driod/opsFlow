import type { Request } from 'express';
import ActivityLog, {
  type ActivityAction,
  type ActivityResource,
  type ActivitySeverity,
  type IActivityChange,
} from '../models/ActivityLog.js';

interface LogActivityParams {
  req: Request;
  action: ActivityAction;
  resource: ActivityResource;
  resourceId?: string | undefined;
  /** Short human sentence for the log row. Auto-generated if omitted. */
  summary?: string | undefined;
  /** Field-level diff, typically from `diffFields`. */
  changes?: IActivityChange[] | undefined;
  details?: Record<string, unknown> | undefined;
  severity?: ActivitySeverity | undefined;
}

const SENSITIVE_RESOURCES: ActivityResource[] = ['USER', 'BUSINESS', 'PAYROLL', 'EXPORT', 'AUTH'];

const deriveSeverity = (
  action: ActivityAction,
  resource: ActivityResource,
  changes?: IActivityChange[],
): ActivitySeverity => {
  if (action === 'DELETE') return 'sensitive';
  if (SENSITIVE_RESOURCES.includes(resource) && action !== 'VIEW') return 'sensitive';
  if (changes?.some((c) => c.field === 'role' || c.field === 'currency')) return 'sensitive';
  if (action === 'PAYMENT' || action === 'SEND' || action === 'EXPORT') return 'notice';
  return 'info';
};

const autoSummary = (
  action: ActivityAction,
  resource: ActivityResource,
  details?: Record<string, unknown>,
): string => {
  const label = resource.toLowerCase().replace(/_/g, ' ');
  const name =
    (details?.name as string) ||
    (details?.clientName as string) ||
    (details?.invoiceNumber as string) ||
    (details?.description as string) ||
    '';
  const verb: Record<ActivityAction, string> = {
    CREATE: 'Created',
    UPDATE: 'Updated',
    DELETE: 'Deleted',
    LOGIN: 'Signed in',
    LOGOUT: 'Signed out',
    VIEW: 'Viewed',
    SEND: 'Sent',
    PAYMENT: 'Recorded payment on',
    EXPORT: 'Exported',
  };
  if (action === 'LOGIN' || action === 'LOGOUT') return verb[action];
  return `${verb[action]} ${label}${name ? ` “${name}”` : ''}`.trim();
};

/**
 * Compute a field-level diff between two plain objects, limited to `keys`.
 * Only keys whose value actually changed are returned.
 */
export const diffFields = (
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  keys: string[],
): IActivityChange[] => {
  const b = before ?? {};
  const a = after ?? {};
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const changes: IActivityChange[] = [];
  for (const field of keys) {
    const from = norm(b[field]);
    const to = norm(a[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from: b[field], to: a[field] });
  }
  return changes;
};

export const logActivity = async ({
  req,
  action,
  resource,
  resourceId,
  summary,
  changes,
  details,
  severity,
}: LogActivityParams): Promise<void> => {
  try {
    if (!req.user) {
      console.warn('Cannot log activity: no authenticated user');
      return;
    }

    // An UPDATE that changed nothing isn't worth a row.
    if (action === 'UPDATE' && changes && changes.length === 0) return;

    await ActivityLog.create({
      user: req.user._id,
      userName: req.user.name,
      userEmail: req.user.email,
      action,
      resource,
      resourceId,
      summary: summary || autoSummary(action, resource, details),
      changes: changes && changes.length ? changes : undefined,
      details,
      severity: severity || deriveSeverity(action, resource, changes),
      businessId: req.user.businessId,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress,
      userAgent: req.get('user-agent'),
    });
  } catch (error) {
    // Logging must never break the request it describes.
    console.error('Failed to log activity:', error);
  }
};

/** Fire-and-forget wrapper — use in controllers so a logging failure can't reject the response. */
export const audit = (params: LogActivityParams): void => {
  void logActivity(params);
};

interface AuthEventParams {
  req: Request;
  action: Extract<ActivityAction, 'LOGIN' | 'LOGOUT'>;
  user: { _id: unknown; name: string; email: string; businessId: unknown };
  details?: Record<string, unknown>;
}

/**
 * Auth events happen before `req.user` is populated, so the user is passed
 * explicitly. Fire-and-forget.
 */
export const logAuthEvent = ({ req, action, user, details }: AuthEventParams): void => {
  void (async () => {
    try {
      await ActivityLog.create({
        user: user._id,
        userName: user.name,
        userEmail: user.email,
        action,
        resource: 'AUTH',
        summary: action === 'LOGIN' ? 'Signed in' : 'Signed out',
        details,
        severity: 'notice',
        businessId: user.businessId,
        ipAddress:
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          req.ip ||
          req.socket?.remoteAddress,
        userAgent: req.get('user-agent'),
      });
    } catch (error) {
      console.error('Failed to log auth event:', error);
    }
  })();
};
