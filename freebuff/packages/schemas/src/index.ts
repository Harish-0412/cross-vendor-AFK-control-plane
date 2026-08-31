export * from './session.schema';
export * from './event.schema';
export * from './command.schema';
export * from './project.schema';
export * from './sandbox.schema';
export * from './agent.schema';
export * from './gateway.schema';
export * from './device.schema';

import type { z } from 'zod';

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; errors: Array<{ path: string; message: string }> };

export function toParseResult<T>(result: z.SafeParseReturnType<unknown, T>): ParseResult<T> {
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

export function assertValid<T>(
  result: z.SafeParseReturnType<unknown, T>,
  errorMessage = 'Validation failed',
): T {
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`${errorMessage}:\n${issues}`);
  }
  return result.data;
}
