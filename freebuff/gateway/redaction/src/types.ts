export interface RedactionMatch {
  type: string;
  name: string;
  value: string;
  index: number;
  length: number;
  pattern: string;
}

export interface RedactionResult {
  text: string;
  matches: RedactionMatch[];
  redacted: boolean;
  originalLength: number;
  redactedLength: number;
}

export interface RedactionOptions {
  placeholder?: string;
  preserveLength?: boolean;
  customPatterns?: CustomPattern[];
  enabledTypes?: string[];
  disabledTypes?: string[];
  maxMatches?: number;
  contextChars?: number;
}

export interface CustomPattern {
  name: string;
  pattern: RegExp;
  type: string;
  placeholder?: string;
}

export interface Redactor {
  redact(text: string): RedactionResult;
  redactObject<T>(obj: T): T;
  redactStream(stream: AsyncIterable<string>): AsyncIterable<string>;
  addPattern(pattern: CustomPattern): void;
  removePattern(name: string): void;
  getPatterns(): CustomPattern[];
}

export interface DataClassification {
  level: 'public' | 'internal' | 'confidential' | 'restricted';
  categories: string[];
  pii: boolean;
  secrets: boolean;
  credentials: boolean;
}

export interface Classifier {
  classify(text: string): DataClassification;
  shouldRedact(classification: DataClassification): boolean;
}

export interface RedactionPolicy {
  defaultAction: 'redact' | 'block' | 'allow';
  rules: RedactionRule[];
}

export interface RedactionRule {
  pattern: string | RegExp;
  action: 'redact' | 'block' | 'allow';
  type?: string;
  fields?: string[];
}

export type SecretType = 
  | 'api_key'
  | 'aws_access_key'
  | 'aws_secret_key'
  | 'github_token'
  | 'stripe_key'
  | 'openai_key'
  | 'jwt_token'
  | 'bearer_token'
  | 'private_key'
  | 'ssh_key'
  | 'connection_string'
  | 'password'
  | 'database_url'
  | 'custom';