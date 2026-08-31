// Passwords in code - TypeScript

// Direct assignment
const password = "supersecretpassword123";
const passwd = "anotherpassword456";
const pwd = "mypassword789";
const secret = "mysecretkey";
const apiSecret = "api-secret-value";

// In object
const config = {
  password: "configpassword123",
  secret: "configsecret456",
  apiKey: "apikeyvalue789"
};

// Database config
const dbConfig = {
  username: "admin",
  password: "dbpassword123",
  host: "localhost",
  port: 5432
};

// Environment variables
const envPassword = process.env.DB_PASSWORD || "defaultpass";
const apiKey = process.env.API_KEY || "defaultkey";

// Connection string with password
const connectionString = "postgresql://user:password@localhost:5432/db";

// JWT secret
const jwtSecret = "jwt-signing-secret-key-very-long-and-random";

// Encryption key
const encryptionKey = "encryption-key-32-bytes-long!!";

// OAuth secret
const oauthSecret = "oauth-client-secret-value";

// Test with comments
const testPassword = "testpassword"; // This is a test password
const prodPassword = "prodpassword"; /* Production password */

// Not a password (should not match)
const userName = "john_doe";
const displayName = "John Doe";
const tempVariable = "temporary_value";
const randomString = "abcdefghijklmnopqrstuvwxyz";