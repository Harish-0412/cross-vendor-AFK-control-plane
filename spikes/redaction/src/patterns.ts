import { CustomPattern, SecretType } from './types';

export const BUILTIN_PATTERNS: CustomPattern[] = [
  // API Keys - Generic
  {
    name: 'generic_api_key',
    pattern: /(?:api[_-]?key|apikey)[\s:=]["']([A-Za-z0-9\-_]{20,})/gi,
    type: 'api_key',
    placeholder: '[REDACTED_API_KEY]'
  },

  // Stripe
  {
    name: 'stripe_secret_key',
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    type: 'stripe_key',
    placeholder: '[REDACTED_STRIPE_KEY]'
  },
  {
    name: 'stripe_publishable_key',
    pattern: /pk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    type: 'stripe_key',
    placeholder: '[REDACTED_STRIPE_KEY]'
  },

  // GitHub
  {
    name: 'github_personal_access_token',
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    type: 'github_token',
    placeholder: '[REDACTED_GITHUB_TOKEN]'
  },
  {
    name: 'github_oauth_token',
    pattern: /gho_[A-Za-z0-9]{36}/g,
    type: 'github_token',
    placeholder: '[REDACTED_GITHUB_TOKEN]'
  },
  {
    name: 'github_user_token',
    pattern: /ghu_[A-Za-z0-9]{36}/g,
    type: 'github_token',
    placeholder: '[REDACTED_GITHUB_TOKEN]'
  },
  {
    name: 'github_server_token',
    pattern: /ghs_[A-Za-z0-9]{36}/g,
    type: 'github_token',
    placeholder: '[REDACTED_GITHUB_TOKEN]'
  },
  {
    name: 'github_refresh_token',
    pattern: /ghr_[A-Za-z0-9]{36}/g,
    type: 'github_token',
    placeholder: '[REDACTED_GITHUB_TOKEN]'
  },

  // OpenAI
  {
    name: 'openai_api_key',
    pattern: /sk-[A-Za-z0-9]{48}/g,
    type: 'openai_key',
    placeholder: '[REDACTED_OPENAI_KEY]'
  },

  // AWS
  {
    name: 'aws_access_key_id',
    pattern: /AKIA[0-9A-Z]{16}/g,
    type: 'aws_access_key',
    placeholder: '[REDACTED_AWS_ACCESS_KEY]'
  },
  {
    name: 'aws_secret_access_key',
    pattern: /(?:aws[_-]?secret[_-]?access[_-]?key|aws_secret_key)[\s:=]["']([A-Za-z0-9\/+=]{40})/gi,
    type: 'aws_secret_key',
    placeholder: '[REDACTED_AWS_SECRET_KEY]'
  },
  {
    name: 'aws_session_token',
    pattern: /(?:aws[_-]?session[_-]?token)[\s:=]["']([A-Za-z0-9\/+=]+)/gi,
    type: 'aws_secret_key',
    placeholder: '[REDACTED_AWS_SESSION_TOKEN]'
  },

  // GCP
  {
    name: 'gcp_service_account',
    pattern: /"type":\s*"service_account"[\s\S]{100,?"private_key":\s*"-----BEGIN PRIVATE KEY-----/gi,
    type: 'private_key',
    placeholder: '[REDACTED_GCP_SERVICE_ACCOUNT]'
  },
  {
    name: 'gcp_oauth_token',
    pattern: /ya29\.[A-Za-z0-9\-_]+/g,
    type: 'bearer_token',
    placeholder: '[REDACTED_GCP_OAUTH_TOKEN]'
  },

  // Azure
  {
    name: 'azure_connection_string',
    pattern: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/gi,
    type: 'connection_string',
    placeholder: '[REDACTED_AZURE_CONNECTION_STRING]'
  },

  // JWT
  {
    name: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
    type: 'jwt_token',
    placeholder: '[REDACTED_JWT]'
  },

  // Bearer tokens
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,
    type: 'bearer_token',
    placeholder: '[REDACTED_BEARER_TOKEN]'
  },
  {
    name: 'authorization_header',
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi,
    type: 'bearer_token',
    placeholder: '[REDACTED_AUTH_HEADER]'
  },

  // Private Keys
  {
    name: 'rsa_private_key',
    pattern: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g,
    type: 'private_key',
    placeholder: '[REDACTED_RSA_PRIVATE_KEY]'
  },
  {
    name: 'ec_private_key',
    pattern: /-----BEGIN EC PRIVATE KEY-----[\s\S]*?-----END EC PRIVATE KEY-----/g,
    type: 'private_key',
    placeholder: '[REDACTED_EC_PRIVATE_KEY]'
  },
  {
    name: 'openssh_private_key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
    type: 'private_key',
    placeholder: '[REDACTED_OPENSSH_PRIVATE_KEY]'
  },
  {
    name: 'generic_private_key',
    pattern: /-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g,
    type: 'private_key',
    placeholder: '[REDACTED_PRIVATE_KEY]'
  },
  {
    name: 'pem_certificate',
    pattern: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    type: 'private_key',
    placeholder: '[REDACTED_CERTIFICATE]'
  },

  // SSH Keys
  {
    name: 'ssh_rsa_public_key',
    pattern: /ssh-rsa\s+[A-Za-z0-9\/+=]+\s+\S+/g,
    type: 'ssh_key',
    placeholder: '[REDACTED_SSH_RSA_KEY]'
  },
  {
    name: 'ssh_ed25519_public_key',
    pattern: /ssh-ed25519\s+[A-Za-z0-9\/+=]+\s+\S+/g,
    type: 'ssh_key',
    placeholder: '[REDACTED_SSH_ED25519_KEY]'
  },
  {
    name: 'ecdsa_public_key',
    pattern: /ecdsa-sha2-nistp(?:256|384|521)\s+[A-Za-z0-9\/+=]+\s+\S+/g,
    type: 'ssh_key',
    placeholder: '[REDACTED_ECDSA_KEY]'
  },

  // Connection Strings
  {
    name: 'postgres_connection_string',
    pattern: /postgres(?:ql)?:\/\/[^:\/\s]+:[^@\s]+@[^:\/\s]+:\d+\/\w+/gi,
    type: 'connection_string',
    placeholder: '[REDACTED_POSTGRES_URL]'
  },
  {
    name: 'mysql_connection_string',
    pattern: /mysql:\/\/[^:\/\s]+:[^@\s]+@[^:\/\s]+:\d+\/\w+/gi,
    type: 'connection_string',
    placeholder: '[REDACTED_MYSQL_URL]'
  },
  {
    name: 'mongodb_connection_string',
    pattern: /mongodb(?:\+srv)?:\/\/[^:\/\s]+:[^@\s]+@[^:\/\s]+(?::\d+)?\/\w+/gi,
    type: 'connection_string',
    placeholder: '[REDACTED_MONGODB_URL]'
  },
  {
    name: 'redis_connection_string',
    pattern: /redis:\/\/[^:\/\s]*:[^@\s]+@[^:\/\s]+:\d+/gi,
    type: 'connection_string',
    placeholder: '[REDACTED_REDIS_URL]'
  },
  {
    name: 'generic_database_url',
    pattern: /(?:database[_-]?url|db[_-]?url|datasource)[\s:=]["']([^"']+)["']/gi,
    type: 'database_url',
    placeholder: '[REDACTED_DB_URL]'
  },

  // Passwords
  {
    name: 'password_assignment',
    pattern: /(?:password|passwd|pwd|pass|secret|api[_-]?secret)[\s:=]["']([^"'\s]{8,})["']/gi,
    type: 'password',
    placeholder: '[REDACTED_PASSWORD]'
  },
  {
    name: 'password_in_object',
    pattern: /["']password["']\s*:\s*["']([^"']{8,})["']/gi,
    type: 'password',
    placeholder: '[REDACTED_PASSWORD]'
  },
  {
    name: 'secret_in_object',
    pattern: /["']secret["']\s*:\s*["']([^"']{8,})["']/gi,
    type: 'password',
    placeholder: '[REDACTED_SECRET]'
  },

  // Slack
  {
    name: 'slack_token',
    pattern: /xox[baprs]-[A-Za-z0-9\-]+/g,
    type: 'api_key',
    placeholder: '[REDACTED_SLACK_TOKEN]'
  },
  {
    name: 'slack_webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/g,
    type: 'api_key',
    placeholder: '[REDACTED_SLACK_WEBHOOK]'
  },

  // Generic high-entropy strings (potential secrets)
  {
    name: 'high_entropy_string',
    pattern: /[A-Za-z0-9\/+=]{40,}/g,
    type: 'custom',
    placeholder: '[REDACTED_HIGH_ENTROPY]'
  }
];

export const FILE_PATTERNS: CustomPattern[] = [
  {
    name: 'env_file',
    pattern: /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/gm,
    type: 'custom',
    placeholder: '[REDACTED_ENV_VAR]'
  },
  {
    name: 'docker_env',
    pattern: /ENV\s+([A-Z_][A-Z0-9_]*)\s*=\s*(.+)/gi,
    type: 'custom',
    placeholder: '[REDACTED_DOCKER_ENV]'
  }
];

export function getPatternsByType(type: SecretType): CustomPattern[] {
  return BUILTIN_PATTERNS.filter(p => p.type === type);
}

export function getAllPatterns(): CustomPattern[] {
  return [...BUILTIN_PATTERNS];
}

export function createPatternRegistry(customPatterns: CustomPattern[] = []): Map<string, CustomPattern> {
  const registry = new Map<string, CustomPattern>();
  
  for (const pattern of [...BUILTIN_PATTERNS, ...customPatterns]) {
    registry.set(pattern.name, pattern);
  }
  
  return registry;
}

export const SECRET_TYPES: SecretType[] = [
  'api_key',
  'aws_access_key',
  'aws_secret_key',
  'github_token',
  'stripe_key',
  'openai_key',
  'jwt_token',
  'bearer_token',
  'private_key',
  'ssh_key',
  'connection_string',
  'password',
  'database_url',
  'custom'
];