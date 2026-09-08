import { createRedactor } from './redactor';
import { type Classifier, type DataClassification, type Redactor } from './types';

export class DefaultClassifier implements Classifier {
  private redactor: Redactor;

  constructor() {
    this.redactor = createRedactor();
  }

  classify(text: string): DataClassification {
    const redactionResult = this.redactor.redact(text);

    const categories: string[] = [];
    let pii = false;
    let secrets = false;
    let credentials = false;

    for (const match of redactionResult.matches) {
      categories.push(match.type);

      switch (match.type) {
        case 'private_key':
        case 'ssh_key':
        case 'aws_secret_key':
        case 'jwt_token':
        case 'bearer_token':
        case 'connection_string':
        case 'password':
          credentials = true;
          secrets = true;
          break;
        case 'api_key':
        case 'aws_access_key':
        case 'github_token':
        case 'stripe_key':
        case 'openai_key':
          secrets = true;
          break;
      }
    }

    if (this.containsPII(text)) {
      pii = true;
      categories.push('pii');
    }

    let level: DataClassification['level'] = 'public';
    if (credentials) level = 'restricted';
    else if (secrets) level = 'confidential';
    else if (pii) level = 'internal';

    return {
      level,
      categories: [...new Set(categories)],
      pii,
      secrets,
      credentials,
    };
  }

  shouldRedact(classification: DataClassification): boolean {
    return classification.level !== 'public';
  }

  private containsPII(text: string): boolean {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // Credit card
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
      /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // Phone
    ];

    return piiPatterns.some((pattern) => pattern.test(text));
  }
}

export class DataBoundary {
  private classifier: Classifier;
  private redactor: Redactor;
  private policy: 'strict' | 'moderate' | 'lenient';

  constructor(policy: 'strict' | 'moderate' | 'lenient' = 'strict') {
    this.classifier = new DefaultClassifier();
    this.redactor = createRedactor();
    this.policy = policy;
  }

  process(text: string): { text: string; classification: DataClassification; blocked: boolean } {
    const classification = this.classifier.classify(text);
    const shouldRedact = this.classifier.shouldRedact(classification);

    let blocked = false;
    let processedText = text;

    if (this.policy === 'strict' && classification.credentials) {
      blocked = true;
      processedText = '[BLOCKED: Contains credentials]';
    } else if (shouldRedact) {
      processedText = this.redactor.redact(text).text;
    }

    return {
      text: processedText,
      classification,
      blocked,
    };
  }

  processObject<T>(obj: T): {
    object: T | null;
    classification: DataClassification;
    blocked: boolean;
  } {
    const text = JSON.stringify(obj);
    const result = this.process(text);

    if (result.blocked) {
      return { object: null, classification: result.classification, blocked: true };
    }

    try {
      return {
        object: JSON.parse(result.text) as T,
        classification: result.classification,
        blocked: false,
      };
    } catch {
      return { object: obj, classification: result.classification, blocked: false };
    }
  }
}

export function createDataBoundary(policy?: 'strict' | 'moderate' | 'lenient'): DataBoundary {
  return new DataBoundary(policy);
}

export const CLASSIFICATION_LEVELS = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
} as const;
