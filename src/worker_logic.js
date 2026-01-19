// steam_worker/src/worker_logic.js

const SteamConnector = require('./steam_connector');
const SteamInviteCleaner = require('./steam_invite_cleaner');

/**
 * Worker Logic Module
 * 
 * Handles all Steam-related operations:
 * - Slot initialization
 * - Cleanup of old invites
 * - Sending friend invites
 * - Error classification
 */
class WorkerLogic {
  constructor(logger = console) {
    this.logger = logger;
    this.steamConnector = new SteamConnector(logger);
    this.inviteCleaner = new SteamInviteCleaner(logger);
  }

  /**
   * Main entry point: Process invites for an account
   * 
   * @param {Object} params - Processing parameters
   * @param {Object} params.account - Steam account info
   * @param {Object} params.credentials - Steam credentials
   * @param {Array} params.targets - Targets to send invites to
   * @param {Object} params.options - Processing options
   * 
   * @returns {Object} Processing results
   */
  async processInvites(params) {
    const { account, credentials, targets, options } = params;
    const username = account.username || account.steam_login || 'unknown';
    
    this.logger.info(`[WORKER] Starting invite processing for ${username}`);
    this.logger.info(`[WORKER] Targets: ${targets.length}, Max batch: ${options.max_invites_per_batch}`);

    const result = {
      success: false,
      results: {
        successful: [],
        failed: [],
        temporaryFailures: [],
        limitReached: false,
        invitationErrorCount: 0,
        accountBanned: false
      },
      account_updates: {
        slots_used: 0,
        new_overall_slots: account.overall_friend_slots,
        cleanup_performed: false,
        slots_freed: 0,
        initialization_performed: false
      },
      cooldown_info: {
        should_apply: false,
        error_codes: [],
        reason: null
      }
    };

    let updatedAccount = { ...account };

    try {
      // Step 1: Connect to Steam
      this.logger.info(`[WORKER] Connecting to Steam as ${username}...`);
      const connectionResult = await this.steamConnector.connect(credentials);

      if (!connectionResult.success) {
        this.logger.error(`[WORKER] Connection failed: ${connectionResult.error}`);
        
        // Connection failure triggers cooldown
        result.cooldown_info = {
          should_apply: true,
          error_codes: [],
          reason: 'connection_failure'
        };
        
        return result;
      }

      this.logger.info(`[WORKER] Connected successfully`);

      // Step 2: Refresh account statistics (always)
      this.logger.info(`[WORKER] Refreshing account statistics for ${username}...`);

      const statsResult = await this.steamConnector.getAccountStatistics();

      if (statsResult.success) {
        const previousSlots = updatedAccount.overall_friend_slots;
        updatedAccount.overall_friend_slots = statsResult.stats.totalSlots;
        result.account_updates.new_overall_slots = statsResult.stats.totalSlots;
        result.account_updates.initialization_performed = (previousSlots === null);
        
        if (previousSlots !== null && previousSlots !== statsResult.stats.totalSlots) {
          this.logger.info(`[WORKER] Slots updated: ${previousSlots} -> ${statsResult.stats.totalSlots}`);
        } else {
          this.logger.info(`[WORKER] Current slots: ${statsResult.stats.totalSlots}/250 used`);
        }
      } else {
        throw new Error(`Account statistics refresh failed: ${statsResult.error}`);
      }

      // Step 3: Calculate account capacity
      const capacity = this.calculateAccountCapacity(
        updatedAccount,
        targets.length
      );

      this.logger.info(`[WORKER] Account capacity: can_send=${capacity.can_send}, max_sendable=${capacity.max_sendable}, needs_cleanup=${capacity.needs_cleanup}`);

      if (!capacity.can_send) {
        this.logger.warn(`[WORKER] Account cannot send invites (weekly_limited=${capacity.weekly_limited})`);
        result.results.limitReached = true;
        result.success = true;
        return result;
      }

      // Step 4: Perform cleanup if needed
      if (capacity.needs_cleanup && capacity.cleanup_needed > 0) {
        this.logger.info(`[WORKER] Cleanup needed: freeing ${capacity.cleanup_needed} slots...`);
        
        const cleanupResult = await this.inviteCleaner.cleanupOldInvites(
          this.steamConnector, 
          capacity.cleanup_needed,
          options.oldest_pending_invites || []
        );

        if (cleanupResult.success) {
          updatedAccount.overall_friend_slots = cleanupResult.new_overall_slots;
          result.account_updates.new_overall_slots = cleanupResult.new_overall_slots;
          result.account_updates.cleanup_performed = true;
          result.account_updates.slots_freed = cleanupResult.slots_freed;
          this.logger.info(`[WORKER] Cleanup successful: freed ${cleanupResult.slots_freed} slots`);
        } else {
          this.logger.warn(`[WORKER] Cleanup failed: ${cleanupResult.error}`);
        }
      }

      // Recalculate capacity after cleanup
      const finalCapacity = this.calculateAccountCapacity(
        updatedAccount,
        targets.length
      );

      const actualBatchSize = Math.min(targets.length, finalCapacity.max_sendable);
      const targetsToProcess = targets.slice(0, actualBatchSize);

      this.logger.info(`[WORKER] Sending ${targetsToProcess.length} invites...`);

      // Step 5: Send invites with early detection
      const inviteResults = await this.sendInvitesWithEarlyDetection(
        targetsToProcess,
        options.delay_between_invites_ms || 2000
      );

      // Step 6: Process results
      result.results = inviteResults;
      result.success = true;

      // Update account slots based on successful invites
      const slotsUsed = inviteResults.successful.length;
      result.account_updates.slots_used = slotsUsed;
      result.account_updates.new_overall_slots = updatedAccount.overall_friend_slots + slotsUsed;

      // Step 7: Determine if cooldown should be applied
      // CHANGED: Only apply cooldown for error 15 (rate limiting), NOT for errors 25/84 (account limits)
      if (inviteResults.invitationErrorCount > 0) {
        result.cooldown_info = {
          should_apply: true,
          error_codes: this.extractErrorCodes(inviteResults.failed),
          reason: 'invitation_errors'
        };
      }

      this.logger.info(`[WORKER] Processing complete: ${inviteResults.successful.length} successful, ${inviteResults.failed.length} failed`);

      return result;

    } catch (error) {
      this.logger.error(`[WORKER] Processing failed: ${error.message}`);
      result.success = false;
      result.error = error.message;
      return result;

    } finally {
      // Always disconnect
      await this.steamConnector.disconnect();
      this.logger.info(`[WORKER] Disconnected from Steam`);
    }
  }

  /**
   * Calculate account capacity based on weekly and overall limits
   * 
   * UPDATED: Uses full 250 limit and calculates cleanup dynamically
   */
  calculateAccountCapacity(account, requestedCount) {
    const weeklySlots = account.weekly_invite_slots || 0;
    const overallSlots = account.overall_friend_slots;

    // DEBUG: Log all input parameters
    this.logger.info(`[WORKER] [DEBUG] calculateAccountCapacity called with:`);
    this.logger.info(`[WORKER] [DEBUG]   requestedCount = ${requestedCount}`);
    this.logger.info(`[WORKER] [DEBUG]   weeklySlots = ${weeklySlots}`);
    this.logger.info(`[WORKER] [DEBUG]   overallSlots = ${overallSlots}`);

    if (weeklySlots <= 0) {
      this.logger.info(`[WORKER] [DEBUG] Result: cannot send (weeklySlots <= 0)`);
      return {
        can_send: false,
        max_sendable: 0,
        needs_cleanup: false,
        cleanup_needed: 0,
        weekly_limited: true,
        overall_limited: false
      };
    }

    if (overallSlots === null) {
      const maxSendable = Math.min(requestedCount, weeklySlots);
      this.logger.info(`[WORKER] [DEBUG] Result: overallSlots=null, maxSendable=${maxSendable}`);
      return {
        can_send: true,
        max_sendable: maxSendable,
        needs_cleanup: false,
        cleanup_needed: 0,
        weekly_limited: false,
        overall_limited: false
      };
    }

    const MAX_OVERALL_SLOTS = 250;

    // Calculate how many we can actually send (limited by weekly slots)
    const maxSendable = Math.min(requestedCount, weeklySlots);
    this.logger.info(`[WORKER] [DEBUG]   maxSendable = min(${requestedCount}, ${weeklySlots}) = ${maxSendable}`);

    // Calculate if we need cleanup to accommodate this batch
    const slotsAfterSending = overallSlots + maxSendable;
    this.logger.info(`[WORKER] [DEBUG]   slotsAfterSending = ${overallSlots} + ${maxSendable} = ${slotsAfterSending}`);
    
    if (slotsAfterSending <= MAX_OVERALL_SLOTS) {
      this.logger.info(`[WORKER] [DEBUG] Result: No cleanup needed (${slotsAfterSending} <= ${MAX_OVERALL_SLOTS})`);
      // No cleanup needed - we fit within the 250 limit
      return {
        can_send: true,
        max_sendable: maxSendable,
        needs_cleanup: false,
        cleanup_needed: 0,
        weekly_limited: weeklySlots < requestedCount,
        overall_limited: false
      };
    } else {
      // Cleanup needed: we need to free enough slots to accommodate the batch
      const targetSlotsBeforeInvites = MAX_OVERALL_SLOTS - maxSendable;
      const cleanupNeeded = overallSlots - targetSlotsBeforeInvites;
      
      this.logger.info(`[WORKER] [DEBUG] Cleanup calculation:`);
      this.logger.info(`[WORKER] [DEBUG]   targetSlotsBeforeInvites = ${MAX_OVERALL_SLOTS} - ${maxSendable} = ${targetSlotsBeforeInvites}`);
      this.logger.info(`[WORKER] [DEBUG]   cleanupNeeded = ${overallSlots} - ${targetSlotsBeforeInvites} = ${cleanupNeeded}`);
      this.logger.info(`[WORKER] [DEBUG] Result: needs_cleanup=true, cleanup_needed=${cleanupNeeded}`);
      
      return {
        can_send: true,
        max_sendable: maxSendable,
        needs_cleanup: true,
        cleanup_needed: cleanupNeeded,
        weekly_limited: weeklySlots < requestedCount,
        overall_limited: true
      };
    }
  }

  /**
   * Send invites with early detection of critical errors (15, 25, 84)
   * CHANGED: Both error types stop processing, but only error 15 triggers worker cooldown
   */
  async sendInvitesWithEarlyDetection(targets, delayMs) {
    const results = {
      successful: [],
      failed: [],
      temporaryFailures: [],
      limitReached: false,
      invitationErrorCount: 0,
      accountBanned: false
    };

    // Separate error categories by handling behavior
    const workerCooldownErrors = [15]; // AccessDenied (rate limit) - triggers worker cooldown
    const accountLimitErrors = [25, 84]; // LimitExceeded, RateLimitExceeded - only marks account
    const accountBannedErrors = [17]; // Account banned - stop immediately, flag for invite_friends

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      
      try {
        const inviteResult = await this.steamConnector.addFriend(target.slug);

        if (inviteResult.success) {
          results.successful.push(target.slug);
          this.logger.debug(`[WORKER] ✓ Invite sent to ${target.slug}`);
        } else {
          const errorCode = inviteResult.eresult;
          const errorType = this.classifyError(errorCode, inviteResult.error);

          results.failed.push({
            steamId: target.slug,
            error: inviteResult.error,
            errorCode: errorCode,
            errorType: errorType
          });

          // CHANGED: Set limitReached=true for errors 25 and 84 (account-specific limits)
          if (accountLimitErrors.includes(errorCode) || inviteResult.limitReached) {
            results.limitReached = true;
            this.logger.warn(`[WORKER] Account limit reached (error ${errorCode}), marking account for weekly reset`);
          }

          // CHANGED: Error 15 triggers cooldown AND stops processing
          if (workerCooldownErrors.includes(errorCode)) {
            results.invitationErrorCount++;
            this.logger.warn(`[WORKER] Rate limit error ${errorCode} detected, stopping batch processing and triggering cooldown`);
            
            // Return remaining targets as temporary failures
            for (let j = i + 1; j < targets.length; j++) {
              results.temporaryFailures.push(targets[j].slug);
            }
            
            break;
          }

          // Errors 25/84 stop processing but DON'T trigger cooldown
          if (accountLimitErrors.includes(errorCode)) {
            this.logger.warn(`[WORKER] Account limit error ${errorCode} detected, stopping batch processing WITHOUT cooldown`);

            // Return remaining targets as temporary failures
            for (let j = i + 1; j < targets.length; j++) {
              results.temporaryFailures.push(targets[j].slug);
            }

            break;
          }

          // Error 17 (banned) - stop immediately, flag account for invite_friends to handle
          if (accountBannedErrors.includes(errorCode)) {
            results.accountBanned = true;
            this.logger.warn(`[WORKER] Account BANNED (error ${errorCode}) detected, stopping batch processing immediately`);

            // Return remaining targets as temporary failures (they weren't attempted)
            for (let j = i + 1; j < targets.length; j++) {
              results.temporaryFailures.push(targets[j].slug);
            }

            break;
          }

          this.logger.debug(`[WORKER] ✗ Invite failed for ${target.slug}: ${inviteResult.error} (code: ${errorCode})`);
        }

      } catch (error) {
        this.logger.error(`[WORKER] Exception sending invite to ${target.slug}: ${error.message}`);
        results.failed.push({
          steamId: target.slug,
          error: error.message,
          errorCode: null,
          errorType: 'temporary'
        });
      }

      // Delay between invites (except after last one)
      if (i < targets.length - 1) {
        await this.wait(delayMs);
      }
    }

    return results;
  }

  /**
   * Classify error as 'temporary' or 'definitive'
   */
  classifyError(errorCode, errorMessage) {
    // Definitive errors (don't retry)
    const definitiveErrors = [
      14, // Already friends
      40, // Blocked
      17  // Banned
    ];

    // Temporary errors (should retry)
    const temporaryErrors = [
      15, // AccessDenied (rate limit)
      25, // LimitExceeded
      29, // Timeout
      84  // RateLimitExceeded
    ];

    if (definitiveErrors.includes(errorCode)) {
      return 'definitive';
    }

    if (temporaryErrors.includes(errorCode)) {
      return 'temporary';
    }

    // Default to temporary for unknown errors
    return 'temporary';
  }

  /**
   * Extract error codes from failed results
   */
  extractErrorCodes(failedResults) {
    const codes = failedResults
      .map(f => f.errorCode)
      .filter(code => code !== null && code !== undefined);
    
    return [...new Set(codes)]; // Unique codes
  }

  /**
   * Wait helper
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WorkerLogic;