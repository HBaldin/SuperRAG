import { describe, it, expect, vi } from 'vitest';
import { getCollectionName } from './qdrant.js';

// Mock the config
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    qdrant: {
      url: 'http://localhost:6333',
      collectionPrefix: 'superrag',
      vectorSize: 1024,
      onDiskPayload: true,
    },
    logging: { level: 'error', pretty: false, traceEnabled: false },
  }),
}));

describe('getCollectionName', () => {
  it('should return prefixed collection names', () => {
    expect(getCollectionName('chunks')).toBe('superrag_chunks');
    expect(getCollectionName('files')).toBe('superrag_files');
    expect(getCollectionName('modules')).toBe('superrag_modules');
    expect(getCollectionName('documents')).toBe('superrag_documents');
  });
});
