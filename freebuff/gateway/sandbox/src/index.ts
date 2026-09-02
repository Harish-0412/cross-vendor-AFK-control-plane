export * from './sandbox-manager';
export * from './platform-base';
export * from './profiles';
export * from './platforms/windows';
export * from './platforms/linux';
export * from './platforms/macos';

// Protocol types re-exported once here as a convenience for consumers, so they
// can take the sandbox contract from this package alone. The modules above
// deliberately do not re-export them: doing so in more than one module made
// `export *` above emit duplicate bindings for the same name.
export type { SandboxCapabilities, SandboxConfig } from '@freebuff/protocol';
