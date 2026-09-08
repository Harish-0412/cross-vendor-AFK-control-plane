import { Redactor, RedactionOptions, RedactionResult, RedactionMatch, CustomPattern, SecretType } from './types';
import { createPatternRegistry } from './patterns';

export class DefaultRedactor implements Redactor {
  private patterns: Map<string, CustomPattern>;
  private options: Required<RedactionOptions>;

  constructor(options: RedactionOptions = {}) {
    this.options = {
      placeholder: options.placeholder || '[REDACTED]',
      preserveLength: options.preserveLength || false,
      customPatterns: options.customPatterns || [],
      enabledTypes: options.enabledTypes || [],
      disabledTypes: options.disabledTypes || [],
      maxMatches: options.maxMatches || 1000,
      contextChars: options.contextChars || 0
    };

    this.patterns = createPatternRegistry(this.options.customPatterns);
    this.applyFilters();
  }

  private applyFilters(): void {
    if (this.options.enabledTypes.length > 0) {
      for (const [name, pattern] of this.patterns) {
        if (!this.options.enabledTypes.includes(pattern.type)) {
          this.patterns.delete(name);
        }
      }
    }

    for (const disabledType of this.options.disabledTypes) {
      for (const [name, pattern] of this.patterns) {
        if (pattern.type === disabledType) {
          this.patterns.delete(name);
        }
      }
    }
  }

  addPattern(pattern: CustomPattern): void {
    this.patterns.set(pattern.name, pattern);
  }

  removePattern(name: string): void {
    this.patterns.delete(name);
  }

  getPatterns(): CustomPattern[] {
    return Array.from(this.patterns.values());
  }

  redact(text: string): RedactionResult {
    if (!text || typeof text !== 'string') {
      return this.emptyResult(text);
    }

    const matches: RedactionMatch[] = [];
    let redactedText = text;

    const sortedPatterns = this.getSortedPatterns();

    for (const pattern of sortedPatterns) {
      if (matches.length >= this.options.maxMatches) break;

      const flags = pattern.pattern.flags.includes('g') ? pattern.pattern.flags : pattern.pattern.flags + 'g';
      const regex = new RegExp(pattern.pattern.source, flags);
      let match;

      while ((match = regex.exec(text)) !== null) {
        if (matches.length >= this.options.maxMatches) break;

        const fullMatch = match[0];
        const matchIndex = match.index;

        const existingMatch = matches.find(m => 
          (matchIndex >= m.index && matchIndex < m.index + m.length) ||
          (matchIndex + fullMatch.length > m.index && matchIndex + fullMatch.length <= m.index + m.length) ||
          (matchIndex <= m.index && matchIndex + fullMatch.length >= m.index + m.length)
        );
        if (existingMatch) continue;

        matches.push({
          type: pattern.type,
          name: pattern.name,
          value: fullMatch,
          index: matchIndex,
          length: fullMatch.length,
          pattern: pattern.pattern.source
        });
      }
    }

    // Sort matches by index to apply replacements properly
    matches.sort((a, b) => a.index - b.index);

    let offset = 0;
    for (const match of matches) {
      const pattern = this.patterns.get(match.name);
      if (!pattern) continue;

      const placeholder = pattern.placeholder || this.options.placeholder;
      const replacement = this.options.preserveLength 
        ? 'X'.repeat(match.length)
        : placeholder;

      const adjustedIndex = match.index + offset;
      redactedText = redactedText.slice(0, adjustedIndex) + 
                     replacement + 
                     redactedText.slice(adjustedIndex + match.length);

      offset += replacement.length - match.length;
    }

    return {
      text: redactedText,
      matches,
      redacted: matches.length > 0,
      originalLength: text.length,
      redactedLength: redactedText.length
    };
  }

  private getSortedPatterns(): CustomPattern[] {
    const patterns = Array.from(this.patterns.values());
    
    const priority: Record<SecretType, number> = {
      'private_key': 100,
      'aws_secret_key': 90,
      'jwt_token': 80,
      'bearer_token': 85,
      'connection_string': 70,
      'password': 70,
      'api_key': 60,
      'aws_access_key': 60,
      'github_token': 60,
      'stripe_key': 60,
      'openai_key': 60,
      'ssh_key': 50,
      'database_url': 50,
      'custom': 10
    };

    return patterns.sort((a, b) => (priority[b.type as SecretType] || 0) - (priority[a.type as SecretType] || 0));
  }

  redactObject<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    
    if (typeof obj === 'string') {
      return this.redact(obj).text as unknown as T;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.redactObject(item)) as unknown as T;
    }
    
    if (typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          const redactedVal = this.redact(value);
          if (redactedVal.redacted) {
            result[key] = redactedVal.text;
          } else if (this.isSensitiveKey(key)) {
            result[key] = this.options.placeholder;
          } else {
            result[key] = value;
          }
        } else {
          if (this.isSensitiveKey(key)) {
            result[key] = this.options.placeholder;
          } else {
            result[key] = this.redactObject(value);
          }
        }
      }
      return result as unknown as T;
    }
    
    return obj;
  }

  private isSensitiveKey(key: string): boolean {
    const sensitiveKeys = [
      'password', 'passwd', 'pwd', 'secret', 'token', 'key', 'api_key', 'apikey',
      'access_token', 'refresh_token', 'access_key', 'secret_key', 'private_key',
      'authorization', 'auth', 'credentials', 'connection_string', 'database_url'
    ];
    
    const lowerKey = key.toLowerCase();
    return sensitiveKeys.some(s => lowerKey.includes(s));
  }

  async *redactStream(stream: AsyncIterable<string>): AsyncIterable<string> {
    let buffer = '';
    
    for await (const chunk of stream) {
      buffer += chunk;
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        const result = this.redact(line + '\n');
        yield result.text;
      }
    }
    
    if (buffer) {
      const result = this.redact(buffer);
      yield result.text;
    }
  }

  private emptyResult(text: string): RedactionResult {
    return {
      text: text || '',
      matches: [],
      redacted: false,
      originalLength: text?.length || 0,
      redactedLength: text?.length || 0
    };
  }
}

export function createRedactor(options?: RedactionOptions): Redactor {
  return new DefaultRedactor(options);
}

export class StreamingRedactor {
  private redactor: Redactor;
  private buffer = '';

  constructor(redactor: Redactor) {
    this.redactor = redactor;
  }

  process(chunk: string): string {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    
    let output = '';
    for (const line of lines) {
      output += this.redactor.redact(line + '\n').text;
    }
    return output;
  }

  flush(): string {
    if (!this.buffer) return '';
    const result = this.redactor.redact(this.buffer);
    this.buffer = '';
    return result.text;
  }
}

export function calculateEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const char of str) {
    freq[char] = (freq[char] || 0) + 1;
  }
  
  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  
  return entropy;
}

export function isHighEntropy(str: string, threshold = 3.5): boolean {
  if (str.length < 20) return false;
  return calculateEntropy(str) > threshold;
}