// Thin wrapper around the GitHub REST API (v3), used entirely client-side.
// Auth is a Personal Access Token supplied by the user (never sent anywhere but api.github.com).

const API_ROOT = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export class GitHubApi {
  constructor(token) {
    this.token = token;
  }

  async request(path, options = {}) {
    const res = await fetch(path.startsWith('http') ? path : `${API_ROOT}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      throw new GitHubApiError(data?.message || `GitHub API error (${res.status})`, res.status, data);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ---- Unicode-safe base64 helpers ----
  static encodeContent(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  static decodeContent(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
  }

  async getUser() {
    return this.request('/user');
  }

  async listRepos() {
    let page = 1;
    const all = [];
    for (;;) {
      const batch = await this.request(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      all.push(...batch);
      if (batch.length < 100) break;
      page += 1;
      if (page > 10) break; // safety cap
    }
    return all;
  }

  async getRepo(owner, repo) {
    return this.request(`/repos/${owner}/${repo}`);
  }

  async listBranches(owner, repo) {
    return this.request(`/repos/${owner}/${repo}/branches?per_page=100`);
  }

  async getTree(owner, repo, branch) {
    const branchInfo = await this.request(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    const treeSha = branchInfo.commit.commit.tree.sha;
    const data = await this.request(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
    return data; // { tree: [...], truncated }
  }

  async getFileContent(owner, repo, path, ref) {
    const data = await this.request(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`);
    return {
      sha: data.sha,
      size: data.size,
      encoding: data.encoding,
      content: data.encoding === 'base64' ? GitHubApi.decodeContent(data.content) : data.content,
      raw_base64: data.content
    };
  }

  async createOrUpdateFile(owner, repo, path, content, message, branch, sha) {
    const body = {
      message,
      content: GitHubApi.encodeContent(content),
      branch
    };
    if (sha) body.sha = sha;
    return this.request(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  async uploadBinaryFile(owner, repo, path, base64Content, message, branch, sha) {
    const body = { message, content: base64Content, branch };
    if (sha) body.sha = sha;
    return this.request(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  async deleteFile(owner, repo, path, message, branch, sha) {
    return this.request(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'DELETE',
      body: JSON.stringify({ message, branch, sha })
    });
  }

  // Atomic rename/move using the Git Data API (single commit).
  async renameOrMove(owner, repo, branch, oldPath, newPath, blobSha, mode, message) {
    const ref = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const commitSha = ref.object.sha;
    const commit = await this.request(`/repos/${owner}/${repo}/git/commits/${commitSha}`);
    const baseTreeSha = commit.tree.sha;

    const newTree = await this.request(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [
          { path: oldPath, mode, type: 'blob', sha: null },
          { path: newPath, mode, type: 'blob', sha: blobSha }
        ]
      })
    });

    const newCommit = await this.request(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [commitSha]
      })
    });

    await this.request(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha })
    });

    return newCommit;
  }

  async createFolderPlaceholder(owner, repo, path, branch) {
    return this.createOrUpdateFile(owner, repo, `${path}/.gitkeep`, '', `Create folder ${path}`, branch);
  }

  async listCommitsForPath(owner, repo, path, branch) {
    return this.request(`/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=30`);
  }

  async getContentAtRef(owner, repo, path, ref) {
    return this.getFileContent(owner, repo, path, ref);
  }
}
