const DEFAULTS = {
  minReorgPauseMs: 1600, // visible pause is at least this long (runs alongside the refresh, not after it)
  applyPauseMs: 1200,
  settleMs: 1200, // wait this long after a presence change so a burst of changes is handled once, as its final state
  refreshTimeoutMs: 60000,
  retryDelayMs: 4000,
  maxRetries: 3,
  backgroundRetryMs: 15000, // after giving up, still try again this often
  newFilesCheckMs: 45000, // a check is a full folder rescan: much rarer than the presence heartbeat
  newFilesCountdownS: 10,
  countdownTickMs: 1000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameSet = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]); // both sorted

export function reorgMessage(joined, left) {
  if (joined && left) return "Le groupe a change - repartition des fichiers...";
  if (joined) {
    return joined === 1
      ? "Une personne rejoint le tri - repartition des fichiers..."
      : `${joined} personnes rejoignent le tri - repartition des fichiers...`;
  }
  return left === 1
    ? "Une personne a quitte le tri - repartition des fichiers..."
    : `${left} personnes ont quitte le tri - repartition des fichiers...`;
}

// Everything that has to be coordinated between the sorter (which files are
// mine), presence (who else is here) and the screen, with no DOM knowledge so
// it can be tested on its own.
//
// Guarantees:
//  - only one reorganisation runs at a time, however many changes arrive;
//    a burst is coalesced and handled as its final state (no repeated messages);
//  - the "reorganising" overlay is ALWAYS lifted afterwards, even if the
//    refresh fails or times out (it used to stay up forever on an error);
//  - once the folder is closed or another one opened, nothing from the old
//    session touches the screen or the sorter again.
//
// ui: {
//   showReorg(message), hideReorg(), render(data), toast(message),
//   setNewFilesBanner({ count, secondsLeft } | null), invalidateMedia(),
//   isVisible(), setLoadingText?(text)
// }
export class Coordinator {
  constructor({ sorter, presence, ui, options = {} }) {
    this.sorter = sorter;
    this.presence = presence;
    this.ui = ui;
    this.opts = { ...DEFAULTS, ...options };

    this._epoch = 0; // bumped on open/close: continuations from an older one give up
    this._open = false;
    this._applied = []; // the set of people the sorter's current split is based on
    this._latest = null; // the most recent set presence reported
    this._forceRefresh = false;
    this._forceMessage = "";
    this._reorgDepth = 0;
    this._chain = Promise.resolve();
    this._workerEpoch = null; // epoch of the queued/running worker, if any
    this._retryTimer = null;

    this._watchTimer = null;
    this._checking = false;
    this._pendingNew = [];
    this._dismissed = new Set();
    this._countdown = null;

    presence.onChange = (active) => this._onPresence(active);
    presence.onResume = () => this._onResume();
  }

  get isOpen() {
    return this._open;
  }

  get reorganizing() {
    return this._reorgDepth > 0;
  }

  _current(epoch) {
    return this._open && epoch === this._epoch;
  }

  _exclusive(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  // ---------- opening & closing ----------

  // Loads the folder, joins the presence list and resolves with the first
  // card (or null if a newer open()/close() superseded this one). The split
  // is known before anything is shown, so a person joining a folder that is
  // already being sorted never briefly sees the full, unsplit list.
  async open(folderId, folderName) {
    await this.close();
    const epoch = ++this._epoch;
    // Serialised with everything else: two opens overlapping would load two
    // folders into the one sorter, and whichever finished last would win
    // regardless of which one the screen is showing.
    return this._exclusive(async () => {
      if (epoch !== this._epoch) return null;
      await this.sorter.loadFolder(folderId, folderName);
      if (epoch !== this._epoch) return null;
      this.ui.setLoadingText?.("Verification des autres participants...");
      const active = await this.presence.start(folderId);
      if (epoch !== this._epoch || !active) return null;
      this._open = true;
      this._applied = active;
      this._latest = active;
      this.sorter.setPresence(this.presence.sessionId, active);
      this._startWatch(epoch);
      return this.sorter.current();
    });
  }

  async close() {
    this._open = false;
    this._epoch++;
    this._latest = null;
    this._forceRefresh = false;
    this._clearRetry();
    this._stopWatch();
    if (this._reorgDepth > 0) {
      this._reorgDepth = 0;
      this.ui.hideReorg();
    }
    await this.presence.stop();
    await this.sorter.flushSaves();
  }

  // The page became visible again: beat and look right away.
  resume() {
    return this.presence.resume();
  }

  // ---------- presence-driven reorganisation ----------

  _onPresence(active) {
    if (!this._open) return;
    this._latest = active;
    this._kickWorker();
  }

  _onResume() {
    if (!this._open) return;
    // We were silent long enough that others may have re-split the folder
    // (and worked through our old share) without us.
    this._forceRefresh = true;
    this._forceMessage = "Reconnexion - mise a jour des fichiers...";
    this._kickWorker();
  }

  _needsWork() {
    return this._forceRefresh || (this._latest !== null && !sameSet(this._latest, this._applied));
  }

  _kickWorker() {
    const epoch = this._epoch;
    // The queued/running worker re-reads _latest itself. Tracked per epoch: a
    // worker left over from a previous folder must not swallow a change that
    // belongs to the current one.
    if (this._workerEpoch === epoch) return;
    this._workerEpoch = epoch;
    this._exclusive(async () => {
      try {
        await this._work(epoch);
      } finally {
        if (this._workerEpoch === epoch) this._workerEpoch = null;
      }
    }).catch(() => {});
  }

  async _work(epoch) {
    if (!this._current(epoch)) return;
    await sleep(this.opts.settleMs);
    let failures = 0;
    while (this._current(epoch) && this._needsWork()) {
      const target = this._latest ?? this._applied;
      const forced = this._forceRefresh;
      const joined = target.filter((id) => !this._applied.includes(id)).length;
      const left = this._applied.filter((id) => !target.includes(id)).length;
      const message = joined || left ? reorgMessage(joined, left) : this._forceMessage || "Mise a jour des fichiers...";
      this._forceRefresh = false;
      this._forceMessage = "";
      const ok = await this._refreshAndRender(epoch, message, this.opts.minReorgPauseMs, target);
      if (ok) {
        failures = 0;
        continue;
      }
      if (forced) this._forceRefresh = true;
      if (++failures >= this.opts.maxRetries) {
        this._scheduleBackgroundRetry(epoch);
        return;
      }
      await sleep(this.opts.retryDelayMs);
    }
  }

  _scheduleBackgroundRetry(epoch) {
    this._clearRetry();
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._current(epoch)) this._kickWorker();
    }, this.opts.backgroundRetryMs);
  }

  _clearRetry() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  _beginReorg(message) {
    this._reorgDepth++;
    this.ui.showReorg(message);
  }

  _endReorg(epoch) {
    if (epoch !== this._epoch) return; // close() already lifted it
    this._reorgDepth = Math.max(0, this._reorgDepth - 1);
    if (this._reorgDepth === 0) this.ui.hideReorg();
  }

  _withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("delai depasse")), this.opts.refreshTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Refresh what the group decided, re-split for `people` (default: the set
  // already applied), redraw. The overlay is lifted no matter what happens.
  async _refreshAndRender(epoch, message, minPauseMs, people = null) {
    this._beginReorg(message);
    try {
      await Promise.all([this._withTimeout(this.sorter.refresh()), sleep(minPauseMs)]);
      if (!this._current(epoch)) return false;
      const active = people ?? this._applied;
      this.sorter.setPresence(this.presence.sessionId, active);
      this._applied = active;
      this.ui.invalidateMedia();
      this.ui.render(await this.sorter.current());
      return true;
    } catch {
      if (this._current(epoch)) this.ui.toast("Mise a jour impossible pour l'instant - nouvel essai automatique...");
      return false;
    } finally {
      this._endReorg(epoch);
    }
  }

  // ---------- reaching the end of my share ----------

  // Called when my queue runs out: another session may have left work behind
  // (or files may have been added), so look once more before declaring the
  // folder finished. Renders the result itself.
  reconcileIfDone() {
    if (!this._open) return Promise.resolve();
    const epoch = this._epoch;
    return this._exclusive(async () => {
      if (!this._current(epoch)) return;
      await this._refreshAndRender(epoch, "Verification des derniers fichiers...", Math.min(this.opts.applyPauseMs, 700));
    });
  }

  // "Start over" for the whole folder.
  restart() {
    if (!this._open) return Promise.resolve();
    const epoch = this._epoch;
    return this._exclusive(async () => {
      if (!this._current(epoch)) return;
      this._beginReorg("Remise a zero du dossier...");
      try {
        await this._withTimeout(this.sorter.resetProgress());
        if (!this._current(epoch)) return;
        this.sorter.setPresence(this.presence.sessionId, this._applied);
        this._dismissed.clear();
        this.ui.invalidateMedia();
        this.ui.render(await this.sorter.current());
      } catch (e) {
        if (this._current(epoch)) this.ui.toast(`Impossible de recommencer : ${e.message}`);
      } finally {
        this._endReorg(epoch);
      }
    });
  }

  // ---------- files added while sorting ----------

  _startWatch(epoch) {
    this._stopWatch();
    this._pendingNew = [];
    this._dismissed.clear();
    this._watchTimer = setInterval(() => this._checkNewFiles(epoch), this.opts.newFilesCheckMs);
  }

  _stopWatch() {
    if (this._watchTimer) clearInterval(this._watchTimer);
    this._watchTimer = null;
    this._checking = false;
    this._cancelCountdown();
    this.ui.setNewFilesBanner(null);
  }

  async _checkNewFiles(epoch) {
    if (!this._current(epoch) || this._checking || this.reorganizing || this._countdown) return;
    if (this.ui.isVisible && !this.ui.isVisible()) return; // nobody is looking, don't scan for nothing
    this._checking = true;
    try {
      const ids = await this.sorter.peekNewFileIds();
      if (!this._current(epoch)) return;
      this._pendingNew = ids;
      if (ids.some((id) => !this._dismissed.has(id))) this._startCountdown(epoch, ids.length);
    } catch {
      // offline or a transient Drive error: the next check tries again
    } finally {
      this._checking = false;
    }
  }

  _startCountdown(epoch, count) {
    this._cancelCountdown();
    const state = { remaining: this.opts.newFilesCountdownS, timer: null };
    this._countdown = state;
    this.ui.setNewFilesBanner({ count, secondsLeft: state.remaining });
    state.timer = setInterval(() => {
      if (!this._current(epoch) || this._countdown !== state) {
        clearInterval(state.timer);
        return;
      }
      state.remaining -= 1;
      if (state.remaining <= 0) this.applyNewFilesNow();
      else this.ui.setNewFilesBanner({ count, secondsLeft: state.remaining });
    }, this.opts.countdownTickMs);
  }

  _cancelCountdown() {
    if (this._countdown) clearInterval(this._countdown.timer);
    this._countdown = null;
  }

  // Cancels the countdown and remembers these files so the banner doesn't
  // keep coming back for the same ones (it will for further additions).
  dismissNewFiles() {
    this._cancelCountdown();
    for (const id of this._pendingNew) this._dismissed.add(id);
    this.ui.setNewFilesBanner(null);
  }

  applyNewFilesNow() {
    if (!this._open) return Promise.resolve();
    const epoch = this._epoch;
    this._cancelCountdown();
    this.ui.setNewFilesBanner(null);
    return this._exclusive(async () => {
      if (!this._current(epoch)) return;
      // A reorganisation that ran in the meantime already picked these up.
      if (this._pendingNew.length && this._pendingNew.every((id) => this.sorter.knowsFile(id))) return;
      const ok = await this._refreshAndRender(epoch, "Nouveaux fichiers - mise a jour...", this.opts.applyPauseMs);
      if (ok) this._dismissed.clear();
    });
  }
}
