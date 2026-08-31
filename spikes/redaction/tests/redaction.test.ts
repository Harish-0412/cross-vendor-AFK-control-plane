import { describe, it, expect, beforeAll } from 'vitest';
import { createRedactor, Redaction } from '../src';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Secret Redaction', () => {
  let redactor: ReturnType<typeof createRedactor>;

  beforeAll(() => {
    redactor = createRedactor();
  });

  describe('API Keys', () => {
    it('should redact Stripe secret keys', () => {
      const text = 'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnopqrstuvwxyz123456';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_STRIPE_KEY]');
      expect(result.text).not.toContain('sk_live_abcdefghijklmnopqrstuvwxyz123456');
      expect(result.matches.some(m => m.type === 'stripe_key')).toBe(true);
    });

    it('should redact Stripe publishable keys', () => {
      const text = 'pk_live_abcdefghijklmnopqrstuvwxyz';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_STRIPE_KEY]');
    });

    it('should redact GitHub tokens', () => {
      const text = 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(result.matches.some(m => m.type === 'github_token')).toBe(true);
    });

    it('should redact OpenAI keys', () => {
      const text = 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890abcdef';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_OPENAI_KEY]');
      expect(result.matches.some(m => m.type === 'openai_key')).toBe(true);
    });

    it('should redact Slack tokens', () => {
      const text = 'SLACK_BOT_TOKEN=xoxb-123456789012-abcdefghijklmnopqrstuvwxyz';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_SLACK_TOKEN]');
    });
  });

  describe('AWS Credentials', () => {
    it('should redact AWS Access Key ID', () => {
      const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_AWS_ACCESS_KEY]');
      expect(result.matches.some(m => m.type === 'aws_access_key')).toBe(true);
    });

    it('should redact AWS Secret Access Key', () => {
      const text = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_AWS_SECRET_KEY]');
      expect(result.matches.some(m => m.type === 'aws_secret_key')).toBe(true);
    });
  });

  describe('JWT Tokens', () => {
    it('should redact JWT tokens', () => {
      const text = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_JWT]');
      expect(result.matches.some(m => m.type === 'jwt_token')).toBe(true);
    });

    it('should redact Bearer tokens', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_BEARER_TOKEN]');
      expect(result.matches.some(m => m.type === 'bearer_token')).toBe(true);
    });
  });

  describe('Private Keys', () => {
    it('should redact RSA private keys', () => {
      const text = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0+JhK7XqLh8qj4K9y7z8v9B7xJQKLmNO3pPqRrT5vW6yU8
-----END RSA PRIVATE KEY-----`;
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_RSA_PRIVATE_KEY]');
      expect(result.matches.some(m => m.type === 'private_key')).toBe(true);
    });

    it('should redact EC private keys', () => {
      const text = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJ7XqLh8qj4K9y7z8v9B7xJQKLmNO3pPqRrT5vW6yU8ioAoGCCqGSM49
-----END EC PRIVATE KEY-----`;
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_EC_PRIVATE_KEY]');
    });

    it('should redact OpenSSH private keys', () => {
      const text = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn
-----END OPENSSH PRIVATE KEY-----`;
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_OPENSSH_PRIVATE_KEY]');
    });
  });

  describe('SSH Keys', () => {
    it('should redact RSA public keys', () => {
      const text = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC7XqLh8qj4K9y7z8v9B7xJQKLmNO3pPqRrT5vW6yU8i9K2L3mN4oP5qR6sT7uV8wX9yZ0A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zA4bC5dE6fG7hI8jK9lM0nO1pQ2rS3tU4vW5xY6zA7bC8dE9fG0hI1jK2lM3nO4pQ5rS6tU7vW8xY9zA0bC1dE2fG3hI4jK5lM6nO7pQ8rS9tU0vW1xY2zA3bC4dE5fG6hI7jK8lM9nO0pQ1rS2tU3vW4xY5zA6bC7dE8fG9hI0jK1lM2nO3pQ4rS5tU6vW7xY8zA9bC0dE1fG2hI3jK4lM5nO6pQ7rS8tU9vW0xY1zA2bC3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5bC6dE7fG8hI9jK0lM1nO2pQ3rS4tU5vW6xY7zA8bC9dE0fG1hI2jK3lM4nO5pQ6rS7tU8vW9xY0 user@host';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_SSH_RSA_KEY]');
      expect(result.matches.some(m => m.type === 'ssh_key')).toBe(true);
    });

    it('should redact Ed25519 keys', () => {
      const text = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII7XqLh8qj4K9y7z8v9B7xJQKLmNO3pPqRrT5vW6yU8i user@host';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_SSH_ED25519_KEY]');
    });
  });

  describe('Connection Strings', () => {
    it('should redact PostgreSQL URLs', () => {
      const text = 'postgresql://user:password@localhost:5432/mydb';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_POSTGRES_URL]');
      expect(result.matches.some(m => m.type === 'connection_string')).toBe(true);
    });

    it('should redact MySQL URLs', () => {
      const text = 'mysql://user:password@localhost:3306/mydb';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_MYSQL_URL]');
    });

    it('should redact MongoDB URLs', () => {
      const text = 'mongodb://user:password@localhost:27017/mydb';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_MONGODB_URL]');
    });

    it('should redact Redis URLs', () => {
      const text = 'redis://:password@localhost:6379';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_REDIS_URL]');
    });
  });

  describe('Passwords', () => {
    it('should redact password assignments', () => {
      const text = 'const password = "supersecretpassword123";';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_PASSWORD]');
      expect(result.matches.some(m => m.type === 'password')).toBe(true);
    });

    it('should redact passwords in objects', () => {
      const text = '{"password": "configpassword123", "secret": "configsecret456"}';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_PASSWORD]');
      expect(result.text).toContain('[REDACTED_SECRET]');
    });
  });

  describe('Object Redaction', () => {
    it('should redact nested objects', () => {
      const obj = {
        config: {
          apiKey: 'sk_live_abcdefghijklmnopqrstuvwxyz123456',
          dbPassword: 'dbpassword123'
        },
        user: {
          name: 'John',
          token: 'ghp_abcdefghijklmnopqrstuvwxyz123456'
        }
      };
      
      const result = redactor.redactObject(obj);
      
      expect(result.config.apiKey).toBe('[REDACTED_STRIPE_KEY]');
      expect(result.config.dbPassword).toBe('[REDACTED_PASSWORD]');
      expect(result.user.token).toBe('[REDACTED_GITHUB_TOKEN]');
      expect(result.user.name).toBe('John');
    });

    it('should redact arrays', () => {
      const arr = [
        'sk_live_abcdefghijklmnopqrstuvwxyz123456',
        'normal string',
        { password: 'secret123' }
      ];
      
      const result = redactor.redactObject(arr);
      
      expect(result[0]).toBe('[REDACTED_STRIPE_KEY]');
      expect(result[1]).toBe('normal string');
      expect(result[2].password).toBe('[REDACTED_PASSWORD]');
    });
  });

  describe('File Fixtures', () => {
    const fixturesDir = path.join(__dirname, '..', 'test-fixtures', 'secrets');
    
    it('should redact api-keys.txt', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'api-keys.txt'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.length).toBeGreaterThan(5);
    });

    it('should redact aws-credentials.txt', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'aws-credentials.txt'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.some(m => m.type === 'aws_access_key')).toBe(true);
      expect(result.matches.some(m => m.type === 'aws_secret_key')).toBe(true);
    });

    it('should redact jwt-tokens.txt', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'jwt-tokens.txt'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.some(m => m.type === 'jwt_token')).toBe(true);
      expect(result.matches.some(m => m.type === 'bearer_token')).toBe(true);
    });

    it('should redact private-keys.pem', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'private-keys.pem'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.some(m => m.type === 'private_key')).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(4);
    });

    it('should redact connection-strings.txt', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'connection-strings.txt'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.some(m => m.type === 'connection_string')).toBe(true);
      expect(result.matches.length).toBeGreaterThan(5);
    });

    it('should redact passwords-in-code.ts', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'passwords-in-code.ts'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.some(m => m.type === 'password')).toBe(true);
    });

    it('should redact ssh-keys.pub', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'ssh-keys.pub'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.some(m => m.type === 'ssh_key')).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(3);
    });

    it('should redact mixed-content.md', async () => {
      const content = await fs.readFile(path.join(fixturesDir, 'mixed-content.md'), 'utf-8');
      const result = redactor.redact(content);
      
      expect(result.redacted).toBe(true);
      expect(result.matches.length).toBeGreaterThan(10);
    });
  });

  describe('False Positives', () => {
    it('should not redact documentation words', () => {
      const text = 'This documentation explains how to configure your password settings.';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(false);
    });

    it('should not redact variable names', () => {
      const text = 'const userPassword = "value"; const apiKeyManager = new ApiKeyManager();';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(false);
    });

    it('should not redact UUIDs', () => {
      const text = '123e4567-e89b-12d3-a456-426614174000';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(false);
    });

    it('should not redact version numbers', () => {
      const text = 'version: 1.2.3.4.5.6.7.8.9.0';
      const result = redactor.redact(text);
      
      expect(result.redacted).toBe(false);
    });
  });

  describe('Custom Patterns', () => {
    it('should support custom patterns', () => {
      const customRedactor = createRedactor({
        customPatterns: [{
          name: 'internal-token',
          pattern: /INTERNAL_[A-Z0-9]{32}/g,
          type: 'custom',
          placeholder: '[REDACTED_INTERNAL]'
        }]
      });
      
      const text = 'INTERNAL_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
      const result = customRedactor.redact(text);
      
      expect(result.redacted).toBe(true);
      expect(result.text).toContain('[REDACTED_INTERNAL]');
    });
  });

  describe('Preserve Length', () => {
    it('should preserve length when enabled', () => {
      const preserveRedactor = createRedactor({ preserveLength: true });
      const text = 'password = "secret123"';
      const result = preserveRedactor.redact(text);
      
      expect(result.redactedLength).toBe(result.originalLength);
    });
  });
});