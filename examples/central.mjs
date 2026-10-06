import { centralCount, centralHistogram } from '../runtime/client.mjs';

// Fictional records, public categories, and stable IDs for the same person.
const units = ['example-a', 'example-a', 'example-b', 'example-c'];
const categories = [0, 1, 1, 2];

// Each call is a separate release: publishing both costs at most 2 epsilon.
// Save a returned object for downloads/retries instead of rerunning a query.
const count = centralCount(units, { epsilon: 1, maxContributions: 1 });
const histogram = centralHistogram(units, categories, {
  categoryCount: 3, epsilon: 1, maxContributions: 1,
});
console.log(JSON.stringify({ count, histogram }, null, 2));
