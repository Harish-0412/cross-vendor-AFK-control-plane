# Mixed Content Test

This document contains various types of content mixed with secrets.

## Configuration Section

```yaml
database:
  host: localhost
  port: 5432
  username: admin
  password: "dbpassword123"
  name: mydatabase

api:
  key: "sk_live_abcdefghijklmnopqrstuvwxyz123456"
  secret: "api-secret-value-here"
  endpoint: "https://api.example.com/v1"

redis:
  url: "redis://:redispassword@localhost:6379/0"

jwt:
  secret: "jwt-signing-secret-key-very-long-and-random"
  expiry: "24h"
```

## Code Examples

### JavaScript
```javascript
const config = {
  apiKey: "sk_live_abcdefghijklmnopqrstuvwxyz123456",
  dbPassword: "dbpassword123",
  jwtSecret: "jwt-secret-key"
};

fetch('https://api.example.com/data', {
  headers: {
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  }
});
```

### Python
```python
import os

DATABASE_URL = "postgresql://user:password@localhost:5432/db"
API_KEY = os.environ.get("API_KEY", "sk_live_abcdefghijklmnopqrstuvwxyz123456")
JWT_SECRET = "jwt-signing-secret-key-very-long-and-random"
```

## Regular Text

This is just regular text without any secrets. It contains normal words like
password, secret, token, key, but they're not actual credentials.

User credentials: username=john, password=NOT_A_REAL_PASSWORD

## Environment Variables

```
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
export DATABASE_URL=postgresql://user:pass@localhost:5432/db
export JWT_SECRET=jwt-signing-secret-key
```

## Docker

```dockerfile
FROM node:18
ENV API_KEY=sk_live_abcdefghijklmnopqrstuvwxyz123456
ENV DB_PASSWORD=dbpassword123
ENV JWT_SECRET=jwt-secret-key
RUN npm install
```

## Comments with Secrets (should be caught)

<!-- TODO: Remove this API key: sk_live_abcdefghijklmnopqrstuvwxyz123456 -->
# FIXME: Database password is dbpassword123
// NOTE: JWT secret: jwt-signing-secret-key-very-long-and-random

## False Positives (should NOT be redacted)

- The word "password" in documentation
- Variable named "userPassword" (camelCase)
- Function called "getSecret()"
- Class named "ApiKeyManager"
- Random string "abcdefghijklmnopqrstuvwxyz" (too short entropy)
- Version number "1.2.3.4.5.6.7.8.9.0"
- UUID "123e4567-e89b-12d3-a456-426614174000"