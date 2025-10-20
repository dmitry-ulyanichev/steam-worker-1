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
   * @returns {Promise<Object>} Cleanup result
   */
  async cleanupOldInvites(steamConnector, slotsToFree) {
    try {
      this.logger.info(`[CLEANER] Starting cleanup: need to free ${slotsToFree} slots`);

      // Step 1: Get current friends list from Steam
      const friendsResult = await steamConnector.getFriendsList();
      
      if (!friendsResult.success) {
        throw new Error(friendsResult.error);
      }

      // Calculate current breakdown
      const beforeBreakdown = this.calculateSlotBreakdown(friendsResult);
      this.logger.info(`[CLEANER] Current state: ${beforeBreakdown.total_used}/300 total (${beforeBreakdown.total_friends} friends, ${beforeBreakdown.pending_sent} pending sent)`);

      // Step 2: Select oldest pending invites to cancel
      const invitesToCancel = this.selectInvitesToCancel(
        friendsResult.pendingInvites, 
        slotsToFree
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
        
        this.logger.info(`[CLEANER] After cleanup: ${afterBreakdown.total_used}/300 total (freed ${beforeBreakdown.total_used - afterBreakdown.total_used} slots)`);
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

  selectInvitesToCancel(pendingInvites, slotsNeeded) {
    // Filter out invites without valid timestamps
    const validInvites = pendingInvites.filter(invite => {
      const hasFriendSince = invite.friend_since && invite.friend_since > 0;
      if (!hasFriendSince) {
        this.logger.debug(`[CLEANER] Skipping invite ${invite.steamId} - no valid friend_since timestamp`);
      }
      return hasFriendSince;
    });
    
    if (validInvites.length === 0) {
      this.logger.warn(`[CLEANER] No invites with valid timestamps found`);
      return [];
    }
    
    // Sort by friend_since (oldest first)
    const sorted = [...validInvites].sort((a, b) => {
      return (a.friend_since || 0) - (b.friend_since || 0);
    });
    
    const toCancel = sorted.slice(0, slotsNeeded);
    
    this.logger.info(`[CLEANER] Selected ${toCancel.length} oldest invites (from ${validInvites.length} valid)`);
    
    return toCancel.map(invite => invite.steamId);
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