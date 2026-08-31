import { describe, it, expect } from 'vitest';
import { createRedactor } from '../src';

describe('Redaction Performance', () => {
  const redactor = createRedactor();

  const generateText = (sizeKB: number): string => {
    const baseText = `
const apiKey = "sk_live_abcdefghijklmnopqrstuvwxyz123456";
const password = "supersecretpassword123";
const dbUrl = "postgresql://user:password@localhost:5432/db";
const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const rsaKey = \`-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0+JhK7XqLh8qj4K9y7z8v9B7xJQKLmNO3pPqRrT5vW6yU8
-----END RSA PRIVATE KEY-----\`;
const sshKey = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC7XqLh8qj4K9y7z8v9B7xJQKLmNO3pPqRrT5vW6yU8i9K2L3mN4oP5qR6sT7uV8wX9yZ0A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zA4bC5dE6fG7hI8jK9lM0nO1pQ2rS3tU4vW5xY6zA7bC8dE9fG0hI1jK2lM3nO4pQ5rS6tU7vW8xY9zA0bC1dE2fG3hI4jK5lM6nO7pQ8rS9tU0vW1xY2zA3bC4dE5fG6hI7jK8lM9nO0pQ1rS2tU3vW4xY5zA6bC7dE8fG9hI0jK1lM2nO3pQ4rS5tU6vW7xY8zA9bC0dE1fG2hI3jK4lM5nO6pQ7rS8tU9vW0xY1zA2bC3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5bC6dE7fG8hI9jK0lM1nO2pQ3rS4tU5vW6xY7zA8bC9dE0fG1hI2jK3lM4nO5pQ6rS7tU8vW9xY0zA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zA4bC5dE6fG7hI8jK9lM0nO1pQ2rS3tU4vW5xY6zA7bC8dE9fG0hI1jK2lM3nO4pQ5rS6tU7vW8xY9zA0bC1dE2fG3hI4jK5lM6nO7pQ8rS9tU0vW1xY2zA3bC4dE5fG6hI7jK8lM9nO0pQ1rS2tU3vW4xY5zA6bC7dE8fG9hI0jK1lM2nO3pQ4rS5tU6vW7xY8zA9bC0dE1fG2hI3jK4lM5nO6pQ7rS8tU9vW0xY1zA2bC3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5bC6dE7fG8hI9jK0lM1nO2pQ3rS4tU5vW6xY7zA8bC9dE0fG1hI2jK3lM4nO5pQ6rS7tU8vW9xY0 user@host";

const normalText = "This is normal text without any secrets. It contains words like password, secret, token, key but they are not actual credentials. The system should not redact these false positives.";

return baseText.repeat(Math.ceil(sizeKB * 1024 / baseText.length)) + normalText.repeat(Math.ceil(sizeKB * 1024 / normalText.length));
  };

  it('should redact 1KB in under 10ms', () => {
    const text = generateText(1);
    const start = performance.now();
    redactor.redact(text);
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(10);
  });

  it('should redact 10KB in under 50ms', () => {
    const text = generateText(10);
    const start = performance.now();
    redactor.redact(text);
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(50);
  });

  it('should redact 100KB in under 200ms', () => {
    const text = generateText(100);
    const start = performance.now();
    redactor.redact(text);
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(200);
  });

  it('should redact 1MB in under 2 seconds', () => {
    const text = generateText(1024);
    const start = performance.now();
    redactor.redact(text);
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(2000);
  });

  it('should handle object redaction efficiently', () => {
    const obj = {
      config: {
        apiKey: 'sk_live_abcdefghijklmnopqrstuvwxyz123456',
        password: 'supersecretpassword123',
        dbUrl: 'postgresql://user:password@localhost:5432/db'
      },
      users: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `User ${i}`,
        token: `ghp_abcdefghijklmnopqrstuvwxyz123456${i}`,
        secret: `secret-${i}`
      }))
    };

    const start = performance.now();
    redactor.redactObject(obj);
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(100);
  });

  it('should handle streaming redaction', async () => {
    const streamingRedactor = new (await import('../src')).StreamingRedactor(redactor);
    const chunks = Array.from({ length: 100 }, (_, i) => 
      `Line ${i}: apiKey=sk_live_abcdefghijklmnopqrstuvwxyz123456 password=secret123\n`
    );

    const start = performance.now();
    let output = '';
    for (const chunk of chunks) {
      output += streamingRedactor.process(chunk);
    }
    output += streamingRedactor.flush();
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(100);
    expect(output).toContain('[REDACTED_STRIPE_KEY]');
    expect(output).toContain('[REDACTED_PASSWORD]');
  });

  it('should not degrade with repeated operations', () => {
    const text = 'apiKey=sk_live_abcdefghijklmnopqrstuvwxyz123456 password=secret123';
    const durations: number[] = [];
    
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      redactor.redact(text);
      durations.push(performance.now() - start);
    }
    
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const maxDuration = Math.max(...durations);
    
    expect(avgDuration).toBeLessThan(5);
    expect(maxDuration).toBeLessThan(20);
  });
});