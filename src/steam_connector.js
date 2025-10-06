// steam_worker/src/steam_connector.js

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

/**
 * Steam connector for worker instances
 * Simplified version without database dependencies
 */
class SteamConnector {
  constructor(logger = console) {
    this.logger = logger;
    
    // Current connection state
    this.client = null;
    this.isConnected = false;
    this.steamId = null;
    
    // Connection management
    this.connectionTimeout = null;
    this.lastUsedCode = null;
    this.lastCodeTimestamp = null;
    this.connectionAttempts = 0;
    
    // Timer management for cleanup
    this.freshCodeTimeout = null;
    this.freshCodeInterval = null;
  }

  /**
   * Connect to Steam with provided credentials
   */
  async connect(credentials) {
    this.connectionAttempts = 0;
    const username = credentials.username;
    
    this.logger.info(`[STEAM] Connecting as ${username}...`);
    
    try {
      // Create new Steam client
      this.client = new SteamUser();
      
      // Setup event handlers BEFORE attempting connection
      await this.setupConnectionHandlers();
      
      // Generate fresh 2FA code
      const twoFactorCode = this.generateAndTrackFresh2FACode(credentials.sharedSecret);
      
      // Build login options
      const logOnOptions = {
        accountName: username,
        password: credentials.password,
        twoFactorCode: twoFactorCode
      };
      
      this.logger.info(`[STEAM] Attempting logon for ${username}...`);
      
      // Attempt connection
      this.client.logOn(logOnOptions);
      
      // Wait for connection result
      const connectionResult = await this.waitForConnection();
      
      if (connectionResult.success) {
        this.isConnected = true;
        this.steamId = this.client.steamID ? this.client.steamID.getSteamID64() : null;
        this.logger.info(`[STEAM] ✓ Connected successfully as ${username}`);
      }
      
      return connectionResult;
      
    } catch (error) {
      this.logger.error(`[STEAM] Connection failed: ${error.message}`);
      await this.cleanup();
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Setup connection event handlers
   */
  async setupConnectionHandlers() {
    return new Promise((resolve) => {
      this.client.once('loggedOn', () => {
        this.logger.info('[STEAM] Logged on event received');
      });
      
      this.client.once('error', (err) => {
        this.logger.error(`[STEAM] Error event: ${err.message}`);
      });
      
      this.client.once('disconnected', (eresult, msg) => {
        this.logger.info(`[STEAM] Disconnected event: ${msg}`);
      });
      
      resolve();
    });
  }

  /**
   * Wait for connection to complete
   */
  async waitForConnection() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.error('[STEAM] Connection timeout after 30s');
        resolve({
          success: false,
          error: 'Connection timeout'
        });
      }, 30000);
      
      this.client.once('loggedOn', () => {
        clearTimeout(timeout);
        resolve({
          success: true,
          client: this.client
        });
      });
      
      this.client.once('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: err.message
        });
      });
    });
  }

  /**
   * Generate and track fresh 2FA code
   */
  generateAndTrackFresh2FACode(sharedSecret) {
    const now = Date.now();
    const currentCode = SteamTotp.getAuthCode(sharedSecret);
    
    // Track code reuse
    if (this.lastUsedCode === currentCode && this.lastCodeTimestamp) {
      const timeSinceLastUse = now - this.lastCodeTimestamp;
      this.logger.debug(`[STEAM] Reusing code ${currentCode} (${Math.floor(timeSinceLastUse/1000)}s since last use)`);
    }
    
    // Track the code usage
    this.lastUsedCode = currentCode;
    this.lastCodeTimestamp = now;
    
    return currentCode;
  }

  /**
   * Add friend by Steam ID
   */
  async addFriend(steamId) {
    if (!this.isConnected || !this.client) {
      return {
        success: false,
        error: 'Not connected to Steam',
        eresult: null
      };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          success: false,
          error: 'Friend invite timeout',
          eresult: 29
        });
      }, 30000);

      this.client.addFriend(steamId, (err, personaName) => {
        clearTimeout(timeout);
        
        if (err) {
          const result = this.mapSteamErrorToResult(err, steamId);
          resolve(result);
        } else {
          resolve({
            success: true,
            message: `Invite sent to ${personaName || steamId}`,
            eresult: 1
          });
        }
      });
    });
  }

  /**
   * Map Steam error to result object
   */
  mapSteamErrorToResult(err, steamId) {
    const eresult = err.eresult || 0;
    const message = err.message || 'Unknown error';
    
    // Error code mapping
    const errorMap = {
      14: { type: 'definitive', message: 'Already friends', limitReached: false },
      15: { type: 'temporary', message: 'Access denied (rate limit)', limitReached: true },
      17: { type: 'definitive', message: 'Account banned', limitReached: false },
      25: { type: 'temporary', message: 'Limit exceeded', limitReached: true },
      29: { type: 'temporary', message: 'Timeout', limitReached: false },
      40: { type: 'definitive', message: 'Blocked by user', limitReached: false },
      84: { type: 'definitive', message: 'Invalid Steam ID', limitReached: false }
    };
    
    const errorInfo = errorMap[eresult] || { 
      type: 'temporary', 
      message: message, 
      limitReached: false 
    };
    
    return {
      success: false,
      error: errorInfo.message,
      eresult: eresult,
      errorType: errorInfo.type,
      limitReached: errorInfo.limitReached
    };
  }

  /**
   * Get friends list
   */
  async getFriendsList() {
    if (!this.client || !this.client.steamID) {
      return {
        success: false,
        error: 'Not connected to Steam'
      };
    }

    try {
      const friends = this.client.myFriends;
      
      // Wait if friends list not loaded yet
      if (Object.keys(friends).length === 0) {
        this.logger.info('[STEAM] Waiting for friends list to load...');
        await this.wait(3000);
      }
      
      const friendsData = [];
      
      for (const [steamID, relationship] of Object.entries(friends)) {
        let relationshipType;
        switch (relationship) {
          case 3:
            relationshipType = 'friend';
            break;
          case 4:
          case 2:
            relationshipType = 'invite_sent';
            break;
          case 1:
            relationshipType = 'invite_received';
            break;
          default:
            relationshipType = 'unknown';
        }
        
        friendsData.push({
          steamId: steamID,
          relationship: relationship,
          relationshipType: relationshipType
        });
      }
      
      const confirmedFriends = friendsData.filter(f => f.relationshipType === 'friend');
      const pendingInvites = friendsData.filter(f => f.relationshipType === 'invite_sent');
      const receivedInvites = friendsData.filter(f => f.relationshipType === 'invite_received');
      
      return {
        success: true,
        totalFriends: friendsData.length,
        confirmedFriends: confirmedFriends,
        pendingInvites: pendingInvites,
        receivedInvites: receivedInvites,
        allFriends: friendsData
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get account statistics
   */
  async getAccountStatistics() {
    const friendsList = await this.getFriendsList();
    
    if (!friendsList.success) {
      return friendsList;
    }

    const stats = {
      totalSlots: friendsList.totalFriends,
      confirmedFriends: friendsList.confirmedFriends.length,
      pendingInvitesSent: friendsList.pendingInvites.length,
      pendingInvitesReceived: friendsList.receivedInvites.length,
      availableSlots: Math.max(0, 300 - friendsList.totalFriends),
      needsCleanup: friendsList.totalFriends > 270,
      slotsToFree: Math.max(0, friendsList.totalFriends - 270)
    };

    return {
      success: true,
      stats: stats,
      friendsList: friendsList
    };
  }

  /**
   * Cancel friend invite (simple version)
   */
  async cancelFriendInviteSimple(targetSteamId) {
    if (!this.client || !this.client.steamID) {
      return {
        success: false,
        error: 'Not connected to Steam'
      };
    }

    try {
      this.client.removeFriend(targetSteamId);
      
      return {
        success: true,
        steamId: targetSteamId
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        steamId: targetSteamId
      };
    }
  }

  /**
   * Disconnect from Steam
   */
  async disconnect() {
    this.logger.info('[STEAM] Disconnecting...');
    await this.cleanup();
    this.isConnected = false;
    this.steamId = null;
    this.connectionAttempts = 0;
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    // Clear timers
    if (this.freshCodeTimeout) {
      clearTimeout(this.freshCodeTimeout);
      this.freshCodeTimeout = null;
    }
    
    if (this.freshCodeInterval) {
      clearInterval(this.freshCodeInterval);
      this.freshCodeInterval = null;
    }
    
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    
    // Close client
    if (this.client) {
      await this.forceCloseClient();
    }
  }

  /**
   * Force close Steam client
   */
  async forceCloseClient() {
    try {
      if (!this.client) {
        return;
      }
      
      // Remove all listeners
      this.client.removeAllListeners();
      
      // Close connection with timeout
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 2000);

        if (this.client.steamID) {
          this.client.once('disconnected', () => {
            clearTimeout(timeout);
            resolve();
          });

          try {
            this.client.logOff();
          } catch (error) {
            clearTimeout(timeout);
            resolve();
          }
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
      
      this.client = null;
      
    } catch (error) {
      this.client = null;
    }
  }

  /**
   * Wait helper
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SteamConnector;