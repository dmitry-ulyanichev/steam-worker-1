// steam_worker/src/steam_invite_cleaner.js 

/**
 * Steam Invite Cleaner for worker instances
 * Simplified version without database dependencies
 */
class SteamInviteCleaner {
  constructor(logger = console) {
    this.logger = logger;
  }

  /**
   * Clean up old friend invites to free up slots
   * 
   * @param {Object} steamConnector - SteamConnector instance (already connected)
   * @param {number} slotsToFree - Number of slots that need to be freed
   * @param {Array} oldestPendingInvites - Steam IDs from DB (oldest first) for prioritization
   * @returns {Promise<Object>} Cleanup result
   */
  async cleanupOldInvites(steamConnector, slotsToFree, oldestPendingInvites = []) {
    try {
      this.logger.info(`[CLEANER] Starting cleanup: need to free ${slotsToFree} slots`);
      
      if (oldestPendingInvites && oldestPendingInvites.length > 0) {
        this.logger.info(`[CLEANER] Received ${oldestPendingInvites.length} oldest invites from DB for prioritization`);
      }

      // Step 1: Get current friends list from Steam
      const friendsResult = await steamConnector.getFriendsList();
      
      if (!friendsResult.success) {
        throw new Error(friendsResult.error);
      }

      // Calculate current breakdown
      const beforeBreakdown = this.calculateSlotBreakdown(friendsResult);
      this.logger.info(`[CLEANER] Current state: ${beforeBreakdown.total_used}/250 total (${beforeBreakdown.total_friends} friends, ${beforeBreakdown.pending_sent} pending sent)`);

      // Step 2: Select oldest pending invites to cancel (with DB prioritization)
      const invitesToCancel = this.selectInvitesToCancel(
        friendsResult.pendingInvites, 
        slotsToFree,
        oldestPendingInvites  // ← NUEVO: Pasar lista de la DB
      );
      
      if (invitesToCancel.length === 0) {
        this.logger.warn(`[CLEANER] No pending invites found to cancel`);
        return {
          success: true,
          slots_freed: 0,
          new_overall_slots: beforeBreakdown.total_used,
          message: 'No pending invites available to cancel'
        };
      }

      this.logger.info(`[CLEANER] Selected ${invitesToCancel.length} invites to cancel`);

      // Step 3: Cancel invites on Steam
      const cancelResult = await this.cancelInvitesOnSteam(steamConnector, invitesToCancel);
      
      if (!cancelResult.success) {
        throw new Error(cancelResult.error || 'Steam cancellation failed');
      }

      this.logger.info(`[CLEANER] Cancellation completed: ${cancelResult.successful_cancellations}/${invitesToCancel.length} successful`);

      // Step 4: Get updated friend count from Steam
      const updatedFriendsResult = await steamConnector.getFriendsList();
      let newOverallSlots = beforeBreakdown.total_used;
      
      if (updatedFriendsResult.success) {
        const afterBreakdown = this.calculateSlotBreakdown(updatedFriendsResult);
        newOverallSlots = afterBreakdown.total_used;
        
        this.logger.info(`[CLEANER] After cleanup: ${afterBreakdown.total_used}/250 total (freed ${beforeBreakdown.total_used - afterBreakdown.total_used} slots)`);
      } else {
        // Estimate based on successful cancellations
        newOverallSlots = beforeBreakdown.total_used - cancelResult.successful_cancellations;
      }

      const actualSlotsFreed = cancelResult.successful_cancellations;

      return {
        success: true,
        slots_freed: actualSlotsFreed,
        slots_requested: slotsToFree,
        canceled_steam_ids: cancelResult.canceled_steam_ids,
        new_overall_slots: newOverallSlots
      };

    } catch (error) {
      this.logger.error(`[CLEANER] Cleanup failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        slots_freed: 0
      };
    }
  }

  /**
   * Calculate slot breakdown from friends list result
   */
  calculateSlotBreakdown(friendsListResult) {
    return {
      total_friends: friendsListResult.confirmedFriends.length,
      pending_sent: friendsListResult.pendingInvites.length,
      pending_received: friendsListResult.receivedInvites.length,
      total_used: friendsListResult.totalFriends
    };
  }

  /**
   * Select invites to cancel with DB prioritization
   * 
   * @param {Array} pendingInvites - Pending invites from Steam
   * @param {number} slotsNeeded - Number of slots to free
   * @param {Array} oldestPendingInvites - Steam IDs from DB (oldest first)
   * @returns {Array} Steam IDs to cancel
   */
  selectInvitesToCancel(pendingInvites, slotsNeeded, oldestPendingInvites = []) {
    if (pendingInvites.length === 0) {
      this.logger.warn(`[CLEANER] No pending invites found in Steam`);
      return [];
    }

    const toCancel = [];
    const pendingSteamIds = new Set(pendingInvites.map(inv => inv.steamId));

    this.logger.info(`[CLEANER] Found ${pendingInvites.length} pending invites in Steam, need to cancel ${slotsNeeded}`);

    // Priority 1: Cancel from oldestPendingInvites (from DB) that exist in Steam's pending list
    if (oldestPendingInvites && oldestPendingInvites.length > 0) {
      this.logger.info(`[CLEANER] Priority 1: Checking ${oldestPendingInvites.length} oldest invites from DB...`);
      
      for (const steamId of oldestPendingInvites) {
        if (toCancel.length >= slotsNeeded) break;
        
        if (pendingSteamIds.has(steamId)) {
          toCancel.push(steamId);
          pendingSteamIds.delete(steamId); // Remove to avoid duplicates
        }
      }
      
      this.logger.info(`[CLEANER] Priority 1 result: ${toCancel.length} invites selected from DB list`);
    }

    // Priority 2: If we still need more cancellations, take any remaining pending invites
    if (toCancel.length < slotsNeeded) {
      const remainingNeeded = slotsNeeded - toCancel.length;
      const remaining = Array.from(pendingSteamIds).slice(0, remainingNeeded);
      
      this.logger.info(`[CLEANER] Priority 2: Need ${remainingNeeded} more, selecting from remaining ${pendingSteamIds.size} invites...`);
      
      toCancel.push(...remaining);
      
      this.logger.info(`[CLEANER] Priority 2 result: ${remaining.length} additional invites selected`);
    }

    this.logger.info(`[CLEANER] Final selection: ${toCancel.length} invites to cancel (${Math.min(oldestPendingInvites?.length || 0, slotsNeeded)} from DB priority, ${toCancel.length - Math.min(oldestPendingInvites?.length || 0, toCancel.length)} from fallback)`);

    return toCancel;
  }

  /**
   * Cancel invites on Steam
   */
  async cancelInvitesOnSteam(steamConnector, steamIds) {
    try {
      let successful_cancellations = 0;
      const canceled_steam_ids = [];
      const failed_steam_ids = [];

      this.logger.info(`[CLEANER] Canceling ${steamIds.length} invites on Steam...`);

      for (const steamId of steamIds) {
        try {
          const cancelResult = await steamConnector.cancelFriendInviteSimple(steamId);
          
          if (cancelResult.success) {
            successful_cancellations++;
            canceled_steam_ids.push(steamId);
            this.logger.debug(`[CLEANER] ✓ Canceled ${steamId}`);
          } else {
            failed_steam_ids.push(steamId);
            this.logger.warn(`[CLEANER] ✗ Failed to cancel ${steamId}: ${cancelResult.error}`);
          }

          // Small delay between cancellations
          await this.wait(500);

        } catch (error) {
          failed_steam_ids.push(steamId);
          this.logger.error(`[CLEANER] Exception canceling ${steamId}: ${error.message}`);
        }
      }

      return {
        success: successful_cancellations > 0,
        successful_cancellations,
        canceled_steam_ids,
        failed_steam_ids,
        total_attempted: steamIds.length
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        successful_cancellations: 0,
        canceled_steam_ids: [],
        failed_steam_ids: steamIds
      };
    }
  }

  /**
   * Wait helper
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SteamInviteCleaner;