# Secret Redaction Spike

Pattern-based secret detection and redaction to prevent sensitive data from leaving the machine.

## Architecture

```
spikes/redaction/
├── src/
│   ├── index.ts              # Main redaction API
│   ├── patterns.ts           # Regex patterns for secret detection
│   ├── redactor.ts           # Core redaction engine
│   ├── classifier.ts         # Data classification
│   └── types.ts              # Type definitions
├── test-fixtures/
│   └── secrets/
│       ├── api-keys.txt
│       ├── aws-credentials.txt
│       ├── jwt-tokens.txt
│       ├── private-keys.pem
│       ├── connection-strings.txt
│       ├── passwords-in-code.ts
│       ├── ssh-keys.pub
│       └── mixed-content.md
├── tests/
│   ├── redaction.test.ts
│   └── performance.test.ts
└── README.md
```

## Redaction Patterns

Based on gitleaks patterns and common secret formats:

### API Keys
- Generic: `api_key`, `apikey`, `api-key` followed by 20+ alphanumeric
- Stripe: `sk_live_`, `pk_live_`, `sk_test_`, `pk_test_`
- GitHub: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`
- OpenAI: `sk-` followed by 48 chars

### Cloud Credentials
- AWS Access Key: `AKIA[0-9A-Z]{16}`
- AWS Secret: `aws_secret_access_key` + 40 chars
- GCP: `ya29.` (OAuth), service account keys
- Azure: `DefaultEndpointsProtocol` connection strings

### Tokens & Keys
- JWT: `eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+`
- Bearer: `Bearer [A-Za-z0-9\-._~+/]+=*`
- Private Keys: `-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----`
- SSH: `ssh-rsa`, `ssh-ed25519`, `ecdsa-sha2-nistp256`

### Connection Strings
- PostgreSQL: `postgresql://user:pass@host:port/db`
- MySQL: `mysql://user:pass@host:port/db`
- MongoDB: `mongodb://user:pass@host:port/db`
- Redis: `redis://:pass@host:port`

### Passwords & Secrets
- `password`, `passwd`, `pwd`, `secret` followed by `=` or `:` and value
- `.env` file patterns

## Quick Start

```bash
cd spikes/redaction
npm install
npm run build
npm test

# Test specific fixture
npx ts-node -e "
const { Redactor } = require('./dist');
const redactor = new Redactor();
const result = redactor.redact('const apiKey = \"sk_live_abc123...\";');
console.log(result);
"
```

## Usage

```typescript
import { Redactor, RedactionOptions } from './src';

const redactor = new Redactor({
  placeholder: '[REDACTED]',
  preserveLength: false,
  customPatterns: [
    { name: 'internal-token', pattern: /INTERNAL_[A-Z0-9]{32}/g }
  ]
});

// Redact string
const result = redactor.redact('API key: sk_live_abc123def456');
console.log(result.text);  // "API key: [REDACTED]"
console.log(result.matches);  // [{ type: 'stripe_secret', value: 'sk_live_abc123def456', index: 9 }]

// Redact object (recursively)
const obj = { config: { apiKey: 'sk_live_...', dbUrl: 'postgres://...' } };
const redactedObj = redactor.redactObject(obj);

// Stream redaction for large outputs
for await (const chunk of redactor.redactStream(largeOutput)) {
  process.stdout.write(chunk);
}
```

## Test Fixtures

See `test-fixtures/secrets/` for test cases covering:
- Realistic API keys (fake but format-valid)
- AWS credentials
- JWT tokens
- Private keys (PEM format)
- Database connection strings
- Passwords in code
- SSH public keys
- Mixed content (markdown with embedded secrets)

## Performance Targets

- < 10ms per 1KB of text
- < 100ms per 100KB
- Streaming mode for large outputs
- No false positives on common code patterns

## Integration Points

- **Event Normalizer**: Redact before event leaves Gateway
- **Checkpoint Store**: Redact before persisting session state
- **Tunnel Client**: Final redaction before network send
- **Audit Log**: Redact sensitive fields in audit events