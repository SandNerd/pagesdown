import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTitle, extractDatabaseTitle } from '../src/notion-helpers.js';
import { NotionClient } from '../src/notion.js';

test('extractTitle reads title-type property text', () => {
  const page = {
    properties: {
      Name: {
        type: 'title',
        title: [{ plain_text: 'Alpha Page' }],
      },
    },
  };

  assert.equal(extractTitle(page), 'Alpha Page');
});

test('extractTitle falls back to URL slug', () => {
  const page = {
    url: 'https://www.notion.so/workspace/Quarterly-Roadmap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    properties: {},
  };

  assert.equal(extractTitle(page), 'Quarterly Roadmap');
});

test('extractTitle falls back to id before Untitled', () => {
  const page = {
    id: 'abcd-1234',
    properties: {},
  };

  assert.equal(extractTitle(page), 'abcd-1234');
});

test('extractDatabaseTitle uses database id when title is missing', () => {
  const db = { id: 'db-xyz', title: [] };
  assert.equal(extractDatabaseTitle(db), 'db-xyz');
});

test('NotionClient has clearPageContent and appendPageContent methods', () => {
  const client = new NotionClient('fake-token');
  
  // Check that the methods exist
  assert.equal(typeof client.clearPageContent, 'function');
  assert.equal(typeof client.appendPageContent, 'function');
});

test('NotionClient clearPageContent handles empty response', async () => {
  const client = new NotionClient('fake-token');
  
  // Mock the client to return empty blocks
  const mockPaginate = async () => [];
  client.paginate = mockPaginate;
  client._throttledCall = async (fn) => fn();
  
  const result = await client.clearPageContent('fake-page-id');
  assert.equal(result, 0);
});

test('NotionClient appendPageContent handles empty blocks', async () => {
  const client = new NotionClient('fake-token');
  
  // Mock the throttled call
  client._throttledCall = async (fn) => fn();
  
  const result = await client.appendPageContent('fake-page-id', []);
  assert.equal(result, 0);
});

test('NotionClient appendPageContent batches blocks into chunks of 100', async () => {
  const client = new NotionClient('fake-token');
  
  // Track how many times the API is called
  let callCount = 0;
  client._throttledCall = async (fn) => {
    callCount++;
    return fn();
  };
  
  // Mock the client.blocks.children.append method
  const mockAppend = async (params) => {
    return {};
  };
  client.client = {
    blocks: {
      children: {
        append: mockAppend,
      },
    },
  };
  
  // Create 250 blocks to test batching
  const blocks = Array(250).fill().map((_, i) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: `Block ${i}` } }]
    }
  }));
  
  const result = await client.appendPageContent('fake-page-id', blocks);
  assert.equal(result, 250);
  assert.equal(callCount, 3); // 250 / 100 = 3 batches
});
