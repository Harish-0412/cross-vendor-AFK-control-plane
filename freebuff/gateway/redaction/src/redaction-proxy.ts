import { EventEnvelope, SessionOutputPayload, SessionMessagePayload, ToolCallPayload, ToolResultPayload, FileChangedPayload } from '@freebuff/protocol';
import { Redactor, Classifier, SecretType } from './types';

export interface RedactionProxyStats {
  eventsProcessed: number;
  secretsRedacted: number;
  payloadsBlocked: number;
  redactionsByType: Record<SecretType, number>;
  averageLatencyMs: number;
}

export interface RedactionProxyOptions {
  enabled?: boolean;
}

export interface RedactionProxy {
  redactEvent(event: EventEnvelope): EventEnvelope;
  getStats(): RedactionProxyStats;
}

export class DefaultRedactionProxy implements RedactionProxy {
  private redactor: Redactor;
  private classifier: Classifier;
  private options: RedactionProxyOptions;
  
  private stats: RedactionProxyStats = {
    eventsProcessed: 0,
    secretsRedacted: 0,
    payloadsBlocked: 0,
    redactionsByType: {} as Record<SecretType, number>,
    averageLatencyMs: 0,
  };

  private totalLatencyMs = 0;

  constructor(redactor: Redactor, classifier: Classifier, options?: RedactionProxyOptions) {
    this.redactor = redactor;
    this.classifier = classifier;
    this.options = options || { enabled: true };
  }

  getStats(): RedactionProxyStats {
    return { ...this.stats };
  }

  redactEvent(event: EventEnvelope): EventEnvelope {
    if (this.options.enabled === false) {
      return event;
    }

    const start = performance.now();
    
    // We only process specific event types that contain agent-produced text
    const processedEvent = this.processPayload(event);
    
    const end = performance.now();
    const duration = end - start;
    
    this.totalLatencyMs += duration;
    this.stats.eventsProcessed++;
    this.stats.averageLatencyMs = this.totalLatencyMs / this.stats.eventsProcessed;

    return processedEvent;
  }

  private processPayload(event: EventEnvelope): EventEnvelope {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') {
      return event;
    }

    // Classify payload first
    // We stringify to get a full representation for the classifier
    const payloadStr = JSON.stringify(payload);
    const classification = this.classifier.classify(payloadStr);

    if (classification.level === 'restricted') {
      this.stats.payloadsBlocked++;
      return {
        ...event,
        payload: {
          payload_blocked: true,
          reason: 'restricted_content',
          original_type: event.eventType
        }
      };
    }

    // Only walk specific fields based on event type
    let redactedPayload = payload;

    switch (event.eventType) {
      case 'session.output': {
        const out = payload as SessionOutputPayload;
        const result = this.redactor.redact(out.content);
        this.updateStats(result.matches);
        redactedPayload = { ...out, content: result.text };
        break;
      }
      case 'session.message': {
        const msg = payload as SessionMessagePayload;
        const result = this.redactor.redact(msg.content);
        let thinkingRedacted = msg.thinking;
        
        if (msg.thinking) {
           const thinkingResult = this.redactor.redact(msg.thinking);
           thinkingRedacted = thinkingResult.text;
           this.updateStats(thinkingResult.matches);
        }

        this.updateStats(result.matches);
        redactedPayload = { ...msg, content: result.text, thinking: thinkingRedacted };
        break;
      }
      case 'session.tool_call': {
        const call = payload as ToolCallPayload;
        const result = this.redactor.redactObject(call.arguments);
        // Note: tracking matches inside object redaction would require changes to redactObject, 
        // assuming it doesn't return match stats right now, we just pass the object through.
        redactedPayload = { ...call, arguments: result };
        break;
      }
      case 'session.tool_result': {
        const res = payload as ToolResultPayload;
        const result = this.redactor.redactObject(res.output);
        redactedPayload = { ...res, output: result };
        break;
      }
      case 'session.file_changed': {
        const file = payload as FileChangedPayload;
        if (file.diff) {
          const result = this.redactor.redact(file.diff);
          this.updateStats(result.matches);
          redactedPayload = { ...file, diff: result.text };
        }
        break;
      }
      case 'session.checkpoint':
        // Not walking checkpoint digests/counts, just a placeholder if needed
        break;
      default:
        // Do nothing for other events
        break;
    }

    return {
      ...event,
      payload: redactedPayload
    };
  }

  private updateStats(matches: { type: string }[]) {
    this.stats.secretsRedacted += matches.length;
    for (const match of matches) {
      const type = match.type as SecretType;
      this.stats.redactionsByType[type] = (this.stats.redactionsByType[type] || 0) + 1;
    }
  }
}

export function createRedactionProxy(
  redactor: Redactor,
  classifier: Classifier,
  options?: RedactionProxyOptions,
): RedactionProxy {
  return new DefaultRedactionProxy(redactor, classifier, options);
}
