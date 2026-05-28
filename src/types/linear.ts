// src/types/linear.ts

export interface LinearIssue {
  id: string;
  title: string;
  description: string;
  team: string; // Assuming team ID or name
  updatedAt: string; // ISO date string
  // Add other properties as needed based on Linear API responses
  // e.g., state, assignee, priority, url, labels, etc.
  [key: string]: any; // Allow for other properties
}
