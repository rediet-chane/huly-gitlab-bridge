# Huly-GitLab Sync Bridge 🔄

A production-ready, bidirectional synchronization engine between GitLab and Huly, built during an internship at Awura.
## View Site Link: https://drive.google.com/file/d/1jfM6RpZB20gc9WOPJQ_67e8nS-CvVC1p/view?usp=sharing

## Features ✨

- **Real-time GitLab → Huly Sync**: Webhooks instantly create Huly issues when GitLab issues are opened.
- **Polling-based Huly → GitLab Sync**: Checks Huly every 30 seconds for new issues and pushes them to GitLab.
- **Infinite Loop Prevention**: Uses hidden HTML markers (`<!-- huly-sync:... -->`) to prevent sync loops.
- **Deduplication**: Tracks synced issues in a local state file to prevent duplicate creations.
- **Bidirectional Close Sync**: Adding `[CLOSED]` to a Huly issue title automatically closes the corresponding GitLab issue.

## Architecture 🏗️

```text
GitLab ←→ Node.js Bridge ←→ Huly
   ↓            ↓              ↓
Webhooks   State Management  WebSocket API
REST API   Polling (30s)     Database
