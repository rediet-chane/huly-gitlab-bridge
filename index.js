global.WebSocket = require('ws');
const { connect } = require('@hcengineering/api-client');
const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json());

const HULY_URL   = 'http://localhost:8090';
const WORKSPACE  = 'b06d14be-bab1-4765-8b29-c27ba029b829'; 
const PROJECT_ID = '6a75605f18c6632a0fe3b0b6';
const HULY_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHRyYSI6eyJhdXRoTWV0aG9kIjoicGFzc3dvcmQifSwiYWNjb3VudCI6IjdhOTNiZmYxLTU3ZWQtNDllOS1iODIwLTc0NDZhYmQ0NzQ3MSIsIndvcmtzcGFjZSI6ImIwNmQxNGJlLWJhYjEtNDc2NS04YjI5LWMyN2JhMDI5YjgyOSJ9.9ypNfBW1O6bI9gZbQUw-0TOmVfhm5_oGZRl5PV4pZ_Y';

const GITLAB_TOKEN      = process.env.GITLAB_TOKEN || 'glpat-AbVAaUDjM6AVliiKU9JzU2M6MQpvOjEKdTpuandoZg8.01.171fsvy4m';
const GITLAB_PROJECT_ID = '83669199';

const STATE_FILE = 'issue-mapping.json';

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (!state.hulyIssues) state.hulyIssues = {};
        return state;
    }
    return { issues: {}, hulyIssues: {} };
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getTodoStatus(client) {
    try {
        const statuses = await client.findAll('tracker:class:IssueStatus', {});
        const todo = statuses.find(s =>
            s.name?.toLowerCase() === 'todo' || s.category?.includes('todo')
        ) || statuses[0];
        return todo?._id || null;
    } catch (e) {
        console.error('⚠️ Could not get statuses:', e.message);
        return null;
    }
}

async function createHulyIssue(gitlabIssueId, title, description) {
    let client;
    try {
        console.log(`🔄 Creating Huly issue for GitLab #${gitlabIssueId}...`);
        client = await connect(HULY_URL, { token: HULY_TOKEN, workspace: WORKSPACE });
        const statusId = await getTodoStatus(client);

        await client.addCollection(
            'tracker:class:Issue',
            PROJECT_ID,
            PROJECT_ID,
            'tracker:class:Project',
            'issues',
            {
                title: `[GitLab #${gitlabIssueId}] ${title}`,
                description: `${description || ''}\n\n---\n_Synced from GitLab Issue #${gitlabIssueId}_`,
                status: statusId,
                priority: 0,
                number: 0,
                identifier: ''
            }
        );

        await new Promise(r => setTimeout(r, 1000));
        const issues = await client.findAll('tracker:class:Issue', { title: `[GitLab #${gitlabIssueId}] ${title}` });
        const hulyIssueId = issues[0]?._id;

        console.log(`✅ Created Huly issue: ${hulyIssueId}`);

        const state = loadState();
        state.issues[gitlabIssueId] = { hulyIssueId, lastStatus: 'opened' };
        if (hulyIssueId) state.hulyIssues[hulyIssueId] = { gitlabIssueId, source: 'gitlab' };
        saveState(state);

        return hulyIssueId;
    } catch (error) {
        console.error('❌ Error creating Huly issue:', error.message);
        return null;
    } finally {
        if (client) await client.close();
    }
}

async function syncHulyToGitLab() {
    let client;
    try {
        client = await connect(HULY_URL, { token: HULY_TOKEN, workspace: WORKSPACE });
        const state = loadState();

        const allHulyIssues = await client.findAll('tracker:class:Issue', { space: PROJECT_ID });
        console.log(`🔄 Polling: ${allHulyIssues.length} Huly issues found`);

        const knownHulyIds = new Set(Object.keys(state.hulyIssues));

        for (const hulyIssue of allHulyIssues) {
            const hulyId = hulyIssue._id;
            
            const rawTitle = hulyIssue.title;
            const safeTitle = (typeof rawTitle === 'string' && rawTitle.trim().length > 0) 
                ? rawTitle.trim() 
                : 'Untitled Huly Issue';

            if (!knownHulyIds.has(hulyId) && !safeTitle.startsWith('[GitLab')) {
                console.log(`🔄 New Huly → GitLab: "${safeTitle}"`);
                try {
                    const payload = {
                        title: safeTitle,
                        description: `${hulyIssue.description || ''}\n\n---\n_Synced from Huly_\n<!-- huly-sync:${hulyId} -->`
                    };
                    
                    console.log("📤 Sending payload to GitLab:", JSON.stringify(payload, null, 2));

                    const response = await fetch(`https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/issues`, {
                        method: 'POST',
                        headers: {
                            'PRIVATE-TOKEN': GITLAB_TOKEN,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`GitLab API ${response.status}: ${errorText}`);
                    }
                    
                    const gitlabIssue = await response.json();
                    const gitlabIssueId = gitlabIssue.iid.toString();
                    
                    state.issues[gitlabIssueId] = { hulyIssueId: hulyId, lastStatus: 'opened' };
                    state.hulyIssues[hulyId] = { gitlabIssueId, source: 'huly' };
                    saveState(state);
                    console.log(`✅ Created GitLab #${gitlabIssueId}`);
                } catch (e) {
                    console.error(` GitLab create failed:`, e.message);
                }
            }

            if (knownHulyIds.has(hulyId)) {
                const mapping = state.hulyIssues[hulyId];
                const gitlabId = mapping?.gitlabIssueId || Object.keys(state.issues).find(k => state.issues[k].hulyIssueId === hulyId);

                if (gitlabId && state.issues[gitlabId]?.lastStatus !== 'closed') {
                    if (safeTitle.includes('[CLOSED]')) {
                        try {
                            const response = await fetch(`https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/issues/${gitlabId}`, {
                                method: 'PUT',
                                headers: {
                                    'PRIVATE-TOKEN': GITLAB_TOKEN,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ state_event: 'close' })
                            });
                            
                            if (!response.ok) {
                                const errorText = await response.text();
                                throw new Error(`GitLab API ${response.status}: ${errorText}`);
                            }
                            
                            state.issues[gitlabId].lastStatus = 'closed';
                            saveState(state);
                            console.log(`✅ Closed GitLab #${gitlabId}`);
                        } catch (e) {
                            console.error(`❌ Close GitLab #${gitlabId} failed:`, e.message);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('❌ Poll error:', error.message);
    } finally {
        if (client) await client.close();
    }
}

app.post('/webhook/gitlab', async (req, res) => {
    const event = req.headers['x-gitlab-event'];
    const body = req.body;
    console.log(` GitLab event: ${event}`);

    if (event === 'Issue Hook') {
        const action = body.object_attributes?.action;
        const gitlabIssueId = body.object_attributes?.iid?.toString();
        const title = body.object_attributes?.title;
        const description = body.object_attributes?.description || '';

        if (description.includes('huly-sync:')) {
            console.log(`️ Skipping #${gitlabIssueId} — came from Huly`);
            return res.status(200).send('OK');
        }

        const state = loadState();

        if (action === 'open' && !state.issues[gitlabIssueId]) {
            console.log(`📝 New GitLab #${gitlabIssueId}: ${title}`);
            await createHulyIssue(gitlabIssueId, title, description);
        } else if (action === 'open' && state.issues[gitlabIssueId]) {
            console.log(`️ GitLab #${gitlabIssueId} already synced`);
        } else if (action === 'close') {
            console.log(`🔒 GitLab #${gitlabIssueId} closed`);
        }
    }
    res.status(200).send('OK');
});

app.listen(8000, () => {
    console.log('🚀 Huly-GitLab Sync running on port 8000');
    console.log('🔄 Polling every 30 seconds...');
    syncHulyToGitLab();
    setInterval(syncHulyToGitLab, 30000);
});