import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface ProcessHandle {
  id: string;
  pid: number;
  process: ChildProcess;
  startTime: Date;
  stdout: string[];
  stderr: string[];
  stdoutEmitter: EventEmitter;
  stderrEmitter: EventEmitter;
}

export async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions & { timeout?: number; onStdout?: (line: string) => void; onStderr?: (line: string) => void } = {}
): Promise<ProcessResult> {
  const { timeout = 60000, onStdout, onStderr, ...spawnOptions } = options;
  
  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      onStderr?.(text);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeoutId);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeout}ms`));
        return;
      }
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        duration: Date.now() - startTime
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): ProcessHandle {
  const id = uuidv4();
  const child = spawn(command, args, {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const handle: ProcessHandle = {
    id,
    pid: child.pid || 0,
    process: child,
    startTime: new Date(),
    stdout: [],
    stderr: [],
    stdoutEmitter: new EventEmitter(),
    stderrEmitter: new EventEmitter()
  };

  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    handle.stdout.push(text);
    handle.stdoutEmitter.emit('data', text);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    handle.stderr.push(text);
    handle.stderrEmitter.emit('data', text);
  });

  return handle;
}

export async function waitForProcess(
  handle: ProcessHandle,
  timeout: number = 60000
): Promise<ProcessResult> {
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      handle.process.kill('SIGKILL');
      reject(new Error(`Process timed out after ${timeout}ms`));
    }, timeout);

    handle.process.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeoutId);
      resolve({
        exitCode: code,
        signal,
        stdout: handle.stdout.join(''),
        stderr: handle.stderr.join(''),
        duration: Date.now() - startTime
      });
    });

    handle.process.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

export function killProcess(handle: ProcessHandle, signal: NodeJS.Signals = 'SIGINT'): boolean {
  try {
    return handle.process.kill(signal);
  } catch {
    return false;
  }
}

export function isProcessRunning(handle: ProcessHandle): boolean {
  try {
    process.kill(handle.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPort(port: number, host: string = 'localhost', timeout: number = 5000): Promise<boolean> {
  const net = await import('net');
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const attempt = () => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        if (Date.now() - startTime > timeout) {
          resolve(false);
        } else {
          setTimeout(attempt, 100);
        }
      });
      
      socket.on('error', () => {
        if (Date.now() - startTime > timeout) {
          resolve(false);
        } else {
          setTimeout(attempt, 100);
        }
      });
      
      socket.connect(port, host);
    };
    
    attempt();
  });
}

export function findFreePort(startPort: number = 3000, maxAttempts: number = 100): Promise<number> {
  const net = require('net');
  
  return new Promise((resolve, reject) => {
    let port = startPort;
    let attempts = 0;
    
    const tryPort = () => {
      if (attempts >= maxAttempts) {
        reject(new Error('No free ports available'));
        return;
      }
      
      const server = net.createServer();
      server.once('error', () => {
        port++;
        attempts++;
        tryPort();
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port);
    };
    
    tryPort();
  });
}