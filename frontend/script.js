// FlexTransfer Hub - Main JavaScript File
class FlexTransferHub {
  constructor() {
    this.transfers = [];
    this.activeTab = "all";
    this.viewMode = "list"; // "list" hoặc "grid"
    this.ws = null;
    this.wsUrl = window.FLEX_WS_URL || "ws://localhost:8765/ws";
    this.chunkSize = 512 * 1024; // Tăng chunk size lên 512KB để upload nhanh hơn
    this.lastRenderTime = 0;
    this.renderThrottle = 500; // Giảm throttle xuống 0.5 giây để cập nhật nhanh hơn
    this.maxConcurrentUploads = 5; // Tăng số upload đồng thời từ 2 lên 5
    this.authToken = null; // Auth token for upload
    this.currentUser = null; // Current user info
    this.wsConnectionAttempts = 0; // Track connection attempts
    this.wsReconnectDelay = 1000; // Reconnection delay
    this.init();
  }

  async init() {
    await this.checkAuthentication();
    this.setupEventListeners();
    this.setupDragAndDrop();
    this.setupSettingsModal();
    this.setupViewToggle();
    this.updateStatusCards();
    await this.loadExistingFiles(); // Load files from backend
    await this.refreshDashboardStats(); // FIX: Get real stats from backend
    this.renderTransfers();
    this.connectWebSocket();
  }

  // Check authentication và lấy token
  async checkAuthentication() {
    try {
      // Luôn kiểm tra với file manager server để lấy token mới nhất
      // Không dùng localStorage để tránh token cũ
      const response = await fetch("http://localhost:5000/api/auth/check", {
        method: "GET",
        credentials: "include", // Gửi cookies
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        this.authToken = data.token;
        this.currentUser = data.user;

        // Cập nhật localStorage với token mới
        localStorage.setItem("auth_token", this.authToken);
        localStorage.setItem("user_info", JSON.stringify(this.currentUser));

        this.showNotification(
          `Welcome, ${this.currentUser.username}!`,
          "success"
        );

        console.log(
          `Authenticated as: ${this.currentUser.username} (ID: ${this.currentUser.id})`
        );
      } else {
        throw new Error("Not authenticated");
      }
    } catch (e) {
      console.error("Auth check error:", e);
      this.authToken = null;
      this.currentUser = null;
      this.showNotification(
        "Please login at the file manager to upload files",
        "warning"
      );

      // Hiển thị nút đăng nhập
      this.showLoginPrompt();
    }
  }

  // Hiển thị prompt để đăng nhập
  showLoginPrompt() {
    const existingPrompt = document.querySelector(".login-prompt");
    if (existingPrompt) return; // Đã hiển thị rồi

    const prompt = document.createElement("div");
    prompt.className = "login-prompt";
    prompt.innerHTML = `
      <div style="
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff6b6b;
        color: white;
        padding: 15px 20px;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        z-index: 1000;
        display: flex;
        align-items: center;
        gap: 15px;
      ">
        <span>⚠️ Please login first to upload files</span>
        <button onclick="window.open('http://localhost:5000/login', '_blank')" style="
          background: white;
          color: #ff6b6b;
          border: none;
          padding: 8px 15px;
          border-radius: 5px;
          cursor: pointer;
          font-weight: bold;
        ">Login</button>
        <button onclick="this.parentElement.parentElement.remove()" style="
          background: transparent;
          color: white;
          border: 1px solid white;
          padding: 8px 12px;
          border-radius: 5px;
          cursor: pointer;
        ">×</button>
      </div>
    `;
    document.body.appendChild(prompt);
  }

  // Load existing files from backend
  async loadExistingFiles() {
    console.log("💡 Loading files from current session...");

    // Load files from sessionStorage (chỉ trong session hiện tại)
    try {
      const savedFiles = sessionStorage.getItem("current_session_files");
      if (savedFiles) {
        const files = JSON.parse(savedFiles);
        console.log(`📁 Found ${files.length} files from current session`);
        console.log(
          "📁 Session files:",
          files.map((f) => ({ id: f.id, name: f.name }))
        );
        console.log(
          "📁 Current transfers before load:",
          this.transfers.map((t) => ({ id: t.id, name: t.name }))
        );

        // Convert to transfer format
        files.forEach((file) => {
          const uploadTime = new Date(
            file.uploadedAt || new Date().toISOString()
          );
          const transfer = {
            id: file.id, // Use original ID from sessionStorage
            name: file.name,
            size: file.size,
            type: file.type || "file",
            progress: 100,
            status: "completed",
            speed: 0,
            timeRemaining: 0,
            uploadedAt: file.uploadedAt || new Date().toISOString(),
            startTime: uploadTime,
            endTime: uploadTime,
            uploadTimeDisplay: this.formatUploadTime(uploadTime), // Add formatted time
            category: "upload",
            remoteFileId: file.remoteFileId,
            isCurrentSession: true, // Flag để phân biệt current session
          };

          // Chỉ add nếu chưa có trong transfers (check by ID)
          if (!this.transfers.find((t) => t.id === transfer.id)) {
            this.transfers.push(transfer);
            console.log(
              `✅ Added to transfers: ${transfer.name} (ID: ${transfer.id})`
            );
          } else {
            console.log(
              `⚠️ Skipped duplicate: ${transfer.name} (ID: ${transfer.id})`
            );
          }
        });

        console.log(
          "📁 Current transfers after load:",
          this.transfers.map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
          }))
        );

        this.updateStatusCards();
        this.renderTransfers();
      } else {
        console.log("📝 No files found in current session");
      }
    } catch (error) {
      console.error("Error loading session files:", error);
    }

    // Load files from backend (Previous Uploads)
    await this.loadPreviousUploads();
  }

  // Load previous uploads from backend
  async loadPreviousUploads() {
    if (!this.authToken) {
      console.log("No auth token, skipping previous uploads load");
      return;
    }

    try {
      console.log("Loading previous uploads from backend...");
      const response = await fetch("http://localhost:5000/api/files", {
        method: "GET",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.authToken}`,
        },
      });

      if (response.ok) {
        const files = await response.json();

        // Only show files from last 2 hours
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        const recentFiles = files.filter((file) => {
          const fileTime = new Date(
            file.upload_time || file.created_at
          ).getTime();
          return fileTime > twoHoursAgo;
        });

        console.log(`[DEBUG] Total files from backend: ${files.length}`);
        console.log(`[DEBUG] Files in last 2 hours: ${recentFiles.length}`);

        // Convert recent backend files to frontend transfer format
        recentFiles.forEach((file) => {
          // Skip files stuck in uploading status that are old
          if (file.status === "uploading") {
            const fileAge =
              Date.now() -
              new Date(file.upload_time || file.created_at).getTime();
            const thirtyMinutes = 30 * 60 * 1000;
            if (fileAge > thirtyMinutes) {
              console.warn(
                `Skipping stuck upload: ${file.filename} (age: ${Math.round(
                  fileAge / 60000
                )} minutes)`
              );
              return;
            }
          }

          // Skip if already exists (check by backend file ID only)
          const existingTransfer = this.transfers.find(
            (t) => t.id === `file_${file.id}`
          );
          // Skip if file is already in current session (by name or remoteFileId)
          const sessionTransfer = this.transfers.find(
            (t) =>
              t.isCurrentSession &&
              (t.remoteFileId === file.id ||
                t.name === (file.name || file.filename))
          );
          if (!existingTransfer && !sessionTransfer) {
            const uploadTime = new Date(file.upload_time || Date.now());
            const transfer = {
              id: `file_${file.id}`,
              name: file.name || file.filename,
              size: file.size || 0,
              type: "upload",
              status: file.status === "completed" ? "completed" : "active",
              progress: file.status === "completed" ? 100 : 0,
              speed: "0 B/s",
              startTime: uploadTime,
              endTime: file.status === "completed" ? uploadTime : null,
              uploadTimeDisplay: this.formatUploadTime(uploadTime), // Add time display for Previous Uploads
              downloadUrl:
                file.status === "completed"
                  ? `http://localhost:5000/api/files/${file.id}/download`
                  : null,
              fileId: file.id,
              isExistingFile: true,
              isPreviousSession: true, // Flag để phân biệt files cũ
              category: "upload",
            };
            this.transfers.push(transfer);
            console.log(
              `✅ Added previous upload: ${transfer.name} (ID: ${transfer.id})`
            );
          }
        });

        console.log(
          "📁 All transfers after complete load:",
          this.transfers.length
        );
        this.updateStatusCards();
        this.renderTransfers();
      } else {
        console.error("Failed to load files from backend:", response.status);
      }
    } catch (error) {
      console.error("Error loading previous uploads:", error);
    }
  }

  // Save completed file to sessionStorage
  saveCompletedFileToSession(transfer) {
    try {
      // Get existing saved files
      const savedFiles = JSON.parse(
        sessionStorage.getItem("current_session_files") || "[]"
      );

      // Create file object with consistent ID
      const fileData = {
        id: transfer.id, // Use original transfer ID
        name: transfer.name,
        size: transfer.size,
        type: transfer.type,
        uploadedAt: new Date().toISOString(),
        remoteFileId: transfer.remoteFileId,
      };

      // Remove existing entry with same ID or name, then add new one
      const filteredFiles = savedFiles.filter(
        (f) => f.id !== transfer.id && f.name !== transfer.name
      );
      filteredFiles.push(fileData);

      sessionStorage.setItem(
        "current_session_files",
        JSON.stringify(filteredFiles)
      );
      console.log(
        `💾 Saved file to session: ${transfer.name} (ID: ${transfer.id})`
      );
      console.log(
        `💾 Session now has ${filteredFiles.length} files:`,
        filteredFiles.map((f) => f.name)
      );
    } catch (error) {
      console.error("Error saving file to session:", error);
    }
  }

  // Remove file from sessionStorage
  removeFileFromSession(transferId, transferName) {
    try {
      const savedFiles = JSON.parse(
        sessionStorage.getItem("current_session_files") || "[]"
      );
      const filteredFiles = savedFiles.filter(
        (f) => f.id !== transferId && f.name !== transferName
      );
      sessionStorage.setItem(
        "current_session_files",
        JSON.stringify(filteredFiles)
      );
      console.log(`🗑️ Removed file from session: ${transferName}`);
    } catch (error) {
      console.error("Error removing file from session:", error);
    }

    /* COMMENTED OUT - Previous logic to load files from backend
    if (!this.authToken) {
      console.log("No auth token, skipping file load");
      return;
    }

    try {
      console.log("Loading recent files from backend...");
      const response = await fetch("http://localhost:5000/api/files", {
        method: "GET",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.authToken}`,
        },
      });

      if (response.ok) {
        const files = await response.json();
        
        // Only show files from last 2 hours or current session
        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
        const recentFiles = files.filter(file => {
          const fileTime = new Date(file.upload_time || file.created_at).getTime();
          return fileTime > twoHoursAgo;
        });
        
        console.log(`[DEBUG] Total files from backend: ${files.length}`);
        console.log(`[DEBUG] Files in last 2 hours: ${recentFiles.length}`);
        console.log(`[DEBUG] Filter time: ${new Date(twoHoursAgo).toLocaleString()}`);
        console.log(`[DEBUG] Recent files:`, recentFiles.map(f => ({
          name: f.filename,
          time: new Date(f.upload_time || f.created_at).toLocaleString(),
          status: f.status
        })));

        // Convert recent backend files to frontend transfer format
        recentFiles.forEach((file) => {
          // Skip files stuck in uploading status that are old
          if (file.status === "uploading") {
            const fileAge = Date.now() - new Date(file.upload_time || file.created_at).getTime();
            const thirtyMinutes = 30 * 60 * 1000; // 30 minutes in ms
            
            if (fileAge > thirtyMinutes) {
              console.warn(`Skipping stuck upload: ${file.filename} (age: ${Math.round(fileAge / 60000)} minutes)`);
              return; // Skip this file
            }
          }
          
          const existingTransfer = this.transfers.find(
            (t) => t.id === `file_${file.id}`
          );
          if (!existingTransfer) {
            const uploadTime = new Date(file.upload_time || Date.now());
            const transfer = {
              id: `file_${file.id}`,
              name: file.name || file.filename,
              size: file.size || 0,
              type: "upload",
              status: file.status === "completed" ? "completed" : "active",
              progress: file.status === "completed" ? 100 : 0,
              speed: "0 B/s",
              startTime: uploadTime,
              endTime: file.status === "completed" ? uploadTime : null,
              downloadUrl:
                file.status === "completed"
                  ? `http://localhost:5000/api/files/${file.id}/download`
                  : null,
              fileId: file.id,
              isExistingFile: true,
              isPreviousSession: true, // Flag để phân biệt files cũ
              uploadTimeDisplay: this.formatUploadTime(uploadTime), // Formatted time
            };
            this.transfers.push(transfer);
          }
        });

        // Only show notification for multiple files to avoid spam
        if (recentFiles.length > 2) {
          this.showNotification(
            `Loaded ${recentFiles.length} recent upload${recentFiles.length !== 1 ? 's' : ''} from last 2 hours`,
            "info",
            3000 // Show for 3 seconds only
          );
        }
      } else {
        console.error("Failed to load files:", response.statusText);
      }
    } catch (error) {
      console.error("Error loading existing files:", error);
    }
    */
  }

  // Clear previous session files from current view
  clearPreviousSessionFiles() {
    const currentFiles = this.transfers.length;
    if (currentFiles === 0) {
      this.showNotification("No files to clear", "info", 2000);
      return;
    }

    if (
      confirm(
        `Clear all ${currentFiles} files from current upload session? (Files are safely stored and can be managed in File Manager)`
      )
    ) {
      this.transfers = [];
      // Clear sessionStorage as well
      sessionStorage.removeItem("current_session_files");
      console.log("🗑️ Cleared session storage");

      this.updateStatusCards();
      this.renderTransfers();
      this.showNotification(
        `Cleared ${currentFiles} files from current session`,
        "success",
        3000
      );
    }
  }

  // Throttled render để tránh UI giật
  throttledRender() {
    const now = Date.now();
    if (now - this.lastRenderTime < this.renderThrottle) {
      // Nếu render quá nhanh, defer để smooth hơn
      clearTimeout(this._renderTimeout);
      this._renderTimeout = setTimeout(() => {
        this.renderTransfers();
        this.lastRenderTime = Date.now();
      }, 50); // Delay ngắn để UI smooth
    } else {
      this.renderTransfers();
      this.lastRenderTime = now;
    }
  }

  // Cập nhật tốc độ cho tất cả transfer đang active
  updateTransferSpeeds() {
    const activeTransfers = this.transfers.filter((t) => t.status === "active");
    activeTransfers.forEach((transfer) => {
      if (transfer.type === "upload") {
        // Cập nhật tốc độ cho upload
        const speed = this.computeInstantSpeed(transfer);
        transfer.speed = this.formatSpeed(speed);
      }
    });
  }

  // Throttled render để tránh lag
  throttledRender() {
    const now = Date.now();
    if (now - this.lastRenderTime > this.renderThrottle) {
      // Chỉ cập nhật speed cho files đang active, không render lại toàn bộ UI
      this.updateTransferSpeedsOnly();
      this.updateStatusCards();
      this.lastRenderTime = now;
    }
  }

  // Cập nhật speed mà không re-render toàn bộ UI
  updateTransferSpeedsOnly() {
    const activeTransfers = this.transfers.filter((t) => t.status === "active");
    activeTransfers.forEach((transfer) => {
      // Cập nhật speed display trực tiếp trong DOM
      const transferItem = document.querySelector(
        `[data-transfer-id="${transfer.id}"]`
      );
      if (transferItem) {
        const speedElement = transferItem.querySelector(".transfer-speed");
        const progressElement = transferItem.querySelector(
          ".transfer-percentage"
        );
        const progressFill = transferItem.querySelector(".progress-fill");

        if (speedElement) speedElement.textContent = transfer.speed;
        if (progressElement)
          progressElement.textContent = `${Math.round(transfer.progress)}%`;
        if (progressFill) progressFill.style.width = `${transfer.progress}%`;
      }
    });
  }

  // ===== WebSocket integration =====
  connectWebSocket() {
    try {
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      // Tạo WebSocket URL với auth token nếu có
      let wsUrl = this.wsUrl;
      if (this.authToken) {
        const url = new URL(wsUrl);
        url.searchParams.set("token", this.authToken);
        wsUrl = url.toString();
      }

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        // Only show notification on reconnection, not initial connection
        if (this.wsConnectionAttempts > 0) {
          this.showNotification("Reconnected to upload server", "success");
        }

        // Reset reconnection state
        this.wsConnectionAttempts = 0;
        this.wsReconnectDelay = 1000;

        // Gửi authentication message
        if (this.authToken && this.currentUser) {
          this.ws.send(
            JSON.stringify({
              type: "auth",
              token: this.authToken,
              user: this.currentUser,
            })
          );
        }

        this.maybeStartNextUploads(); // bật lại các job đang chờ, tôn trọng limit
      };

      this.ws.onmessage = (ev) => this.handleWSMessage(ev);

      this.ws.onclose = () => {
        this.showNotification("Disconnected from upload server", "error");
        this.transfers.forEach((t) => {
          if (t.type === "upload" && t.status === "active") t.status = "queued";
        });
        this.renderTransfers();

        // CRITICAL FIX: Auto-reconnect with exponential backoff
        if (!this._manualClose) {
          this.scheduleReconnection();
        }
      };

      this.ws.onerror = (error) => {
        console.warn("WebSocket error:", error);
        this.showNotification(
          "WebSocket connection error - retrying...",
          "warning"
        );
      };
    } catch (e) {
      console.error("Failed to connect WebSocket:", e);
      this.showNotification(
        "Failed to connect to server - retrying in 3s...",
        "error"
      );
      this.scheduleReconnection();
    }
  }

  // CRITICAL FIX: Add WebSocket reconnection with exponential backoff
  async reconnectWebSocket() {
    if (this._reconnecting) {
      console.log("Reconnection already in progress");
      return false;
    }

    this._reconnecting = true;
    this.wsConnectionAttempts++; // Track attempts
    console.log(
      `Attempting WebSocket reconnection (attempt ${this.wsConnectionAttempts})...`
    );

    try {
      // Close existing connection if any
      if (this.ws) {
        this._manualClose = true;
        this.ws.close();
        this._manualClose = false;
      }

      // Wait a bit before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Create new connection
      this.connectWebSocket();

      // Wait for connection to establish
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Connection timeout")),
          5000
        );

        const checkConnection = () => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            clearTimeout(timeout);
            resolve();
          } else if (this.ws && this.ws.readyState === WebSocket.CLOSED) {
            clearTimeout(timeout);
            reject(new Error("Connection failed"));
          } else {
            setTimeout(checkConnection, 100);
          }
        };

        checkConnection();
      });

      console.log("WebSocket reconnection successful");
      // Don't show notification here - it's already shown in onopen
      return true;
    } catch (error) {
      console.error("WebSocket reconnection failed:", error);
      return false;
    } finally {
      this._reconnecting = false;
    }
  }

  scheduleReconnection() {
    if (this._reconnectTimer) return;

    // Exponential backoff: start with 3s, max 30s
    this._reconnectDelay = Math.min((this._reconnectDelay || 3) * 1.5, 30);

    console.log(
      `Scheduling WebSocket reconnection in ${this._reconnectDelay} seconds...`
    );
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      const success = await this.reconnectWebSocket();

      if (success) {
        this._reconnectDelay = 3; // Reset delay on success
      } else {
        this.scheduleReconnection(); // Try again with longer delay
      }
    }, this._reconnectDelay * 1000);
  }

  ensureSocketOpen() {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return resolve();
      this.connectWebSocket();
      const start = Date.now();
      const check = () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return resolve();
        if (Date.now() - start > 5000) return reject(new Error("WS not open"));
        setTimeout(check, 100);
      };
      check();
    });
  }

  send(obj) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch {
      /* ignore */
    }
  }

  handleWSMessage(ev) {
    try {
      const msg = JSON.parse(ev.data);
      // Chỉ log các events quan trọng, không log chunk-ack/progress để tránh spam
      if (!["chunk-ack", "progress"].includes(msg.event)) {
        console.log("WebSocket message received:", msg);
      }
      const fileId = msg.fileId;
      const transfer = this.transfers.find((t) => t.id === fileId);

      if (msg.event === "start-ack") {
        if (!transfer) {
          console.warn("Received start-ack for unknown transfer:", fileId);
          return;
        }
        // Only set to active if not already active (for safety)
        if (transfer.status !== "active") {
          transfer.status = "active";
        }
        transfer.bytesSent = msg.offset || 0;

        // Smooth render và start upload
        this.throttledRender();
        setTimeout(() => {
          this.uploadLoop(transfer);
        }, 30);
      }
      if (msg.event === "progress" || msg.event === "chunk-ack") {
        if (!transfer) {
          console.warn(`Received ${msg.event} for unknown transfer:`, fileId);
          return;
        }
        transfer.bytesSent = msg.offset;
        transfer.progress = Math.min(
          100,
          (transfer.bytesSent / Math.max(transfer.size, 1)) * 100
        );
        transfer.speed = this.formatSpeed(this.computeInstantSpeed(transfer));
        if (transfer.bytesSent >= transfer.size) {
          transfer.progress = 100;
        }

        // Nếu là chunk-ack, báo hiệu cho uploadLoop tiếp tục
        if (msg.event === "chunk-ack") {
          transfer._waitingForAck = false;
        }

        // Chỉ dùng throttled render cho progress để tránh lag
        this.throttledRender();
      }
      if (msg.event === "offset-mismatch") {
        if (!transfer) {
          console.warn(
            "Received offset-mismatch for unknown transfer:",
            fileId
          );
          return;
        }

        const expectedOffset = msg.expected || 0;
        const currentOffset = transfer.bytesSent;

        // Chỉ xử lý khi có mismatch thực sự
        if (expectedOffset !== currentOffset) {
          console.warn(
            `Fixing offset mismatch for ${fileId}: ${currentOffset} → ${expectedOffset}`
          );

          // Dừng loop hiện tại ngay lập tức
          transfer._stopCurrentLoop = true;

          // Cập nhật offset
          transfer.bytesSent = expectedOffset;
          transfer.progress = Math.min(
            100,
            (transfer.bytesSent / Math.max(transfer.size, 1)) * 100
          );

          // Chờ một chút rồi khởi động lại loop với offset mới
          setTimeout(() => {
            if (transfer.status === "active") {
              transfer._stopCurrentLoop = false;
              this.uploadLoop(transfer);
            }
          }, 100);
        }
        // Nếu offset đã đúng, bỏ qua message này
        return;
      }

      if (msg.event === "paused") {
        if (!transfer) {
          console.warn("Received paused for unknown transfer:", fileId);
          return;
        }
        transfer.status = "paused";
        if (typeof msg.offset === "number") transfer.bytesSent = msg.offset;
        this.renderTransfers();
        return;
      }

      if (msg.event === "resume-ack") {
        console.log("Received resume-ack for:", fileId, "offset:", msg.offset);
        if (!transfer) {
          console.warn("Received resume-ack for unknown transfer:", fileId);
          return;
        }

        // CRITICAL FIX: Clear timeout to prevent duplicate upload loop
        if (transfer._resumeTimeoutId) {
          clearTimeout(transfer._resumeTimeoutId);
          transfer._resumeTimeoutId = null;
        }

        console.log(
          "Setting transfer to active and starting upload loop for:",
          fileId
        );
        transfer.status = "active";
        transfer.bytesSent = msg.offset || transfer.bytesSent || 0;
        transfer._stopCurrentLoop = false; // Reset flag khi resume
        transfer._resuming = false; // Reset resuming flag

        // Force immediate render để cập nhật button ngay lập tức
        this.renderTransfers();
        this.updateStatusCards();

        // CRITICAL FIX: Only start upload loop if not already running
        if (!transfer._loopRunning) {
          setTimeout(() => {
            console.log("Starting upload loop for resumed transfer:", fileId);
            this.uploadLoop(transfer);
          }, 50);
        } else {
          console.log(
            "Upload loop already running for:",
            fileId,
            "skipping start"
          );
        }
        return;
      }

      if (msg.event === "stop-ack") {
        // Transfer có thể đã bị xóa từ UI, chỉ cần log
        if (!transfer) {
          console.log(
            "Stop acknowledged for already removed transfer:",
            fileId
          );
          return;
        }
        // Remove transfer
        const idx = this.transfers.findIndex((t) => t.id === fileId);
        if (idx > -1) this.transfers.splice(idx, 1);
        this.updateStatusCards();
        this.renderTransfers();
      }
      if (msg.event === "complete-ack") {
        console.log(
          `[DEBUG] Received complete-ack event for fileId: ${fileId}`,
          msg
        );

        if (!transfer) {
          console.warn("Received complete-ack for unknown transfer:", fileId);
          console.log(
            `[DEBUG] Looking for transfer with ID: ${fileId} in ${this.transfers.length} transfers`
          );
          return;
        }
        transfer.status = "completed";
        transfer.progress = 100;
        transfer.speed = "0 KB/s";
        transfer.endTime = new Date();
        transfer.uploadTimeDisplay = this.formatUploadTime(transfer.endTime);

        console.log(
          `[DEBUG] Updated transfer ${fileId} to completed status via complete-ack`
        );
        console.log(
          `🎯 Transfer completed: ${transfer.name} (${
            this.transfers.filter((t) => t.status === "completed").length
          }/${this.transfers.length} total completed)`
        );

        // Save completed file to sessionStorage
        this.saveCompletedFileToSession(transfer);

        this.updateStatusCards();
        this.renderTransfers();
        // Thử start các transfer đang chờ khác
        this.maybeStartNextUploads();
      }

      if (msg.event === "uploading") {
        if (!transfer) {
          console.warn("Received uploading for unknown transfer:", fileId);
          return;
        }
        transfer.status = "uploading";
        transfer.progress = 100; // Local upload hoàn thành
        this.renderTransfers();
      }

      if (msg.event === "local-complete") {
        if (!transfer) {
          console.warn("Received local-complete for unknown transfer:", fileId);
          return;
        }
        transfer.status = "completing";
        transfer.progress = 100; // Local upload hoàn thành
        this.renderTransfers();
      }

      if (msg.event === "completed") {
        console.log(
          `[DEBUG] Received completed event for fileId: ${fileId}`,
          msg
        );
        console.log(
          `[DEBUG] Available transfers:`,
          this.transfers.map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
          }))
        );

        if (!transfer) {
          console.warn("Received completed for unknown transfer:", fileId);
          console.log(
            `[DEBUG] Looking for transfer with ID: ${fileId} in ${this.transfers.length} transfers`
          );
          return;
        }
        transfer.status = "completed";
        transfer.progress = 100;
        transfer.speed = "0 KB/s";
        transfer.remoteFileId = msg.remoteFileId;
        transfer.endTime = new Date();
        transfer.uploadTimeDisplay = this.formatUploadTime(transfer.endTime);
        console.log(`[DEBUG] Updated transfer ${fileId} to completed status`);
        console.log(
          `🎯 Transfer completed via 'completed' event: ${transfer.name}`
        );

        // Save completed file to sessionStorage
        this.saveCompletedFileToSession(transfer);

        this.updateStatusCards();
        this.renderTransfers();
        // Thử start các transfer đang chờ khác
        this.maybeStartNextUploads();
      }
      if (msg.event === "error") {
        // Không hiển thị lỗi "Session not found" khi đã cancel
        if (msg.error && msg.error.includes("Session not found")) {
          // Chỉ log lỗi này một lần, không spam console
          if (transfer) {
            transfer.status = "stopped"; // Set status to stopped thay vì error
            this.renderTransfers();
          }
          return;
        }

        if (transfer) {
          transfer.status = "error";
        } else {
          console.warn(
            "Received error for unknown transfer:",
            fileId,
            msg.error
          );
        }
        this.showNotification(msg.error || "Upload error", "error");
        this.renderTransfers();
        // Thử start các transfer đang chờ khác
        this.maybeStartNextUploads();
      }

      // Download message handlers
      if (msg.event === "download-start-ack") {
        if (!transfer) {
          console.warn(
            "Received download-start-ack for unknown transfer:",
            fileId
          );
          return;
        }
        transfer.status = "active";
        transfer.size = msg.fileSize || 0;
        this.renderTransfers();
      }

      if (msg.event === "download-progress") {
        if (!transfer) {
          console.warn(
            "Received download-progress for unknown transfer:",
            fileId
          );
          return;
        }
        transfer.progress = msg.progress || 0;
        transfer.bytesSent = msg.bytesDownloaded || 0;
        transfer.size = msg.totalSize || transfer.size;
        transfer.speed = this.formatSpeed(msg.speed || 0);
        this.throttledRender();
      }

      if (msg.event === "download-complete") {
        if (!transfer) {
          console.warn(
            "Received download-complete for unknown transfer:",
            fileId
          );
          return;
        }
        transfer.status = "completed";
        transfer.progress = 100;
        transfer.speed = "0 KB/s";
        this.updateStatusCards();
        this.renderTransfers();
        this.showNotification(
          `Download completed: ${transfer.name}`,
          "success"
        );
      }

      if (msg.event === "download-paused") {
        if (!transfer) {
          console.warn(
            "Received download-paused for unknown transfer:",
            fileId
          );
          return;
        }
        transfer.status = "paused";
        this.renderTransfers();
      }

      if (msg.event === "download-error") {
        if (!transfer) {
          console.warn("Received download-error for unknown transfer:", fileId);
          return;
        }
        transfer.status = "error";
        this.showNotification(`Download failed: ${msg.error}`, "error");
        this.renderTransfers();
      }
    } catch (error) {
      console.error("Error parsing WebSocket message:", error, ev.data);
    }
  }

  async startUpload(transfer) {
    transfer.type = "upload";
    transfer.status = "active"; // Set to active immediately instead of pending
    transfer.progress = 0;
    transfer.speed = "0 KB/s";
    transfer.bytesSent = 0;
    transfer.lastTickBytes = 0;
    transfer.lastTickAt = performance.now();
    transfer._stopCurrentLoop = false; // Reset flag khi bắt đầu upload

    // Debug: log current user and token
    console.log(
      `Starting upload as user: ${this.currentUser?.username} (ID: ${this.currentUser?.id})`
    );
    console.log(`Using token: ${this.authToken?.substring(0, 20)}...`);

    // Update UI immediately to show correct buttons
    this.renderTransfers();

    await this.ensureSocketOpen();
    this.send({
      action: "start",
      fileId: transfer.id,
      fileName: transfer.name,
      fileSize: transfer.size,
      authToken: this.authToken, // Gửi auth token
      user_id: this.currentUser?.id, // Gửi user ID
    });
  }

  async uploadLoop(transfer) {
    console.log(
      "uploadLoop called for:",
      transfer.id,
      "status:",
      transfer.status,
      "loopRunning:",
      transfer._loopRunning
    );

    if (
      !transfer ||
      (transfer.status !== "active" && transfer.status !== "pending")
    ) {
      console.log("uploadLoop exiting - invalid status:", transfer.status);
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log("uploadLoop exiting - WebSocket not open");
      return;
    }

    // CRITICAL FIX: Sử dụng atomic lock để tránh race condition
    if (transfer._loopRunning) {
      console.log("uploadLoop exiting - already running");
      return;
    }
    transfer._loopRunning = true;
    transfer._loopId = Date.now() + Math.random(); // Unique loop ID
    const currentLoopId = transfer._loopId;
    console.log(
      "uploadLoop starting for:",
      transfer.id,
      "loopId:",
      currentLoopId
    );

    try {
      // Check if file object exists before starting upload
      if (!transfer.file) {
        console.error(
          "Upload failed: No file object found for transfer:",
          transfer.id
        );
        transfer.status = "error";
        transfer.error =
          "File object missing. Please try uploading the file again.";
        this.renderTransfers();
        return;
      }

      while (
        transfer.status === "active" &&
        transfer.bytesSent < transfer.size &&
        !transfer._stopCurrentLoop && // Kiểm tra flag để dừng loop
        transfer._loopId === currentLoopId // CRITICAL FIX: Verify loop ownership
      ) {
        const start = transfer.bytesSent; // luôn lấy offset mới nhất
        const end = Math.min(start + this.chunkSize, transfer.size);
        const slice = transfer.file.slice(start, end);
        const buffer = await slice.arrayBuffer();
        const base64 = this.arrayBufferToBase64(buffer);

        // CRITICAL FIX: Double-check loop ownership before sending
        if (
          transfer._loopId !== currentLoopId ||
          transfer.status !== "active" ||
          transfer._stopCurrentLoop
        ) {
          console.log("Upload stopped or ownership changed, breaking loop");
          break;
        }

        // Đánh dấu đang đợi phản hồi
        transfer._waitingForAck = true;

        // gửi chunk
        this.send({
          action: "chunk",
          fileId: transfer.id,
          offset: start,
          data: base64,
        });

        // Đợi server phản hồi chunk-ack với timeout động dựa vào chunk size
        let waitCount = 0;
        const maxWaitTime = Math.max(50, Math.ceil(this.chunkSize / 10240)); // Tối thiểu 5s, thêm 1s cho mỗi 10KB
        while (
          transfer._waitingForAck &&
          transfer.status === "active" &&
          !transfer._stopCurrentLoop &&
          transfer._loopId === currentLoopId && // CRITICAL FIX: Check ownership
          waitCount < maxWaitTime
        ) {
          await new Promise((r) => setTimeout(r, 100)); // Wait 100ms
          waitCount++;
        }

        // CRITICAL FIX: Better timeout handling
        if (waitCount >= maxWaitTime) {
          console.warn(
            `Timeout waiting for chunk-ack after ${
              maxWaitTime * 100
            }ms, will retry connection`
          );
          transfer._waitingForAck = false;

          // Instead of setting error, try to reconnect WebSocket
          if (this.ws.readyState !== WebSocket.OPEN) {
            console.log("WebSocket disconnected, attempting reconnection...");
            await this.reconnectWebSocket();
            // Don't set error, let user manually retry
            transfer.status = "paused";
            this.showNotification(
              `Connection lost for ${transfer.name}. Click Resume to retry.`,
              "warning"
            );
          } else {
            transfer.status = "error";
            transfer.error = "Server response timeout";
          }
          this.renderTransfers();
          break;
        }
        if (
          transfer.status !== "active" ||
          transfer._stopCurrentLoop ||
          transfer._loopId !== currentLoopId
        ) {
          transfer._waitingForAck = false;
          break;
        }
      }

      if (transfer.status === "active" && transfer.bytesSent >= transfer.size) {
        this.send({ action: "complete", fileId: transfer.id });
      }
    } catch (error) {
      console.error("Upload loop error:", error);
      transfer.status = "error";
      transfer.error = error.message || "Upload failed";
      this.renderTransfers();
    } finally {
      // CRITICAL FIX: Always clean up loop state, but only if we own the loop
      if (transfer._loopId === currentLoopId) {
        transfer._loopRunning = false;
        transfer._loopId = null;
        console.log(
          "uploadLoop finished for:",
          transfer.id,
          "final status:",
          transfer.status
        );
      } else {
        console.log(
          "uploadLoop ownership lost for:",
          transfer.id,
          "not cleaning up"
        );
      }
      this.renderTransfers();
      this.updateStatusCards();
    }
  }

  // Retry failed upload
  retryUpload(transfer) {
    if (!transfer || transfer.type !== "upload") return;

    // Reset error state
    delete transfer.error;
    transfer.retryCount = (transfer.retryCount || 0) + 1;

    if (transfer.retryCount > 3) {
      this.showNotification(
        `Upload failed after 3 retries: ${transfer.name}`,
        "error"
      );
      return;
    }

    // Reset to pending and try again
    transfer.status = "pending";
    transfer._waitingForAck = false;
    transfer._stopCurrentLoop = false;

    this.showNotification(
      `Retrying upload (attempt ${transfer.retryCount}): ${transfer.name}`,
      "info"
    );
    this.maybeStartNextUploads();
  }

  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  computeInstantSpeed(transfer, justSentBytes = 0) {
    const now = performance.now();
    const elapsedMs = now - (transfer.lastTickAt || now);
    const bytesDelta =
      transfer.bytesSent - (transfer.lastTickBytes || 0) || justSentBytes;

    if (elapsedMs > 250) {
      transfer.lastTickAt = now;
      transfer.lastTickBytes = transfer.bytesSent;
    }

    const bps = elapsedMs > 0 ? (bytesDelta * 1000) / elapsedMs : 0;

    // Lưu tốc độ hiện tại vào transfer object để sử dụng sau
    transfer.currentSpeedBps = bps;

    return bps;
  }

  // ===== Existing UI wiring =====
  setupEventListeners() {
    // Navigation buttons
    const fileManagerBtn = document.getElementById("file-manager-btn");
    if (fileManagerBtn) {
      fileManagerBtn.addEventListener("click", () => {
        window.location.replace("http://localhost:5000");
      });
    }

    // File dropzone functionality
    const dropzone = document.getElementById("file-dropzone");
    const browseLink = document.getElementById("browse-files-link");
    const dropzoneLabel = document.querySelector(".dropzone");

    if (browseLink && dropzone) {
      browseLink.addEventListener("click", (e) => {
        e.preventDefault();
        dropzone.click();
      });
    }

    if (dropzone) {
      dropzone.addEventListener("change", (e) => {
        this.handleFileSelection(e.target.files);
      });
    }

    // Keyboard support for dropzone
    if (dropzoneLabel && dropzone) {
      dropzoneLabel.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          dropzone.click();
        }
      });
    }

    // URL input functionality
    const urlForm = document.querySelector(".add-url-section");
    const urlInput = document.getElementById("download-url");
    const addUrlBtn = document.getElementById("add-url-btn");

    if (urlForm) {
      urlForm.addEventListener("submit", (e) => {
        e.preventDefault();
        this.addDownloadURL();
      });
    }

    if (addUrlBtn) {
      addUrlBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.addDownloadURL();
      });
    }

    // Tab functionality
    this.setupTabs();

    // Status cards click handlers
    this.setupStatusCards();

    // Clear previous session button
    const clearPreviousBtn = document.getElementById("clear-previous-btn");
    if (clearPreviousBtn) {
      clearPreviousBtn.addEventListener("click", () => {
        this.clearPreviousSessionFiles();
      });
    }
  }

  setupDragAndDrop() {
    const dropzone = document.querySelector(".dropzone");

    if (!dropzone) return;

    ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, () => {
        dropzone.classList.add("drag-over");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      dropzone.addEventListener(eventName, () => {
        dropzone.classList.remove("drag-over");
      });
    });

    dropzone.addEventListener("drop", (e) => {
      const files = e.dataTransfer.files;
      this.handleFileSelection(files);
    });
  }

  setupSettingsModal() {
    const settingsBtn = document.getElementById("settings-btn");
    const settingsModal = document.getElementById("settings-modal");
    const closeSettings = document.getElementById("close-settings");
    const applySettings = document.getElementById("apply-settings");
    const maxConcurrentSlider = document.getElementById(
      "max-concurrent-slider"
    );
    const maxConcurrentValue = document.getElementById("max-concurrent-value");
    const chunkSizeSelect = document.getElementById("chunk-size-select");
    const autoStartQueue = document.getElementById("auto-start-queue");

    // Update slider value display
    maxConcurrentSlider.addEventListener("input", () => {
      maxConcurrentValue.textContent = maxConcurrentSlider.value;
    });

    // Open modal
    settingsBtn.addEventListener("click", () => {
      settingsModal.style.display = "block";
      // Load current settings
      maxConcurrentSlider.value = this.maxConcurrentUploads;
      maxConcurrentValue.textContent = this.maxConcurrentUploads;
      chunkSizeSelect.value = Math.floor(this.chunkSize / 1024);
    });

    // Close modal
    closeSettings.addEventListener("click", () => {
      settingsModal.style.display = "none";
    });

    // Close modal on outside click
    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) {
        settingsModal.style.display = "none";
      }
    });

    // Apply settings
    applySettings.addEventListener("click", () => {
      this.maxConcurrentUploads = parseInt(maxConcurrentSlider.value);
      this.chunkSize = parseInt(chunkSizeSelect.value) * 1024;

      this.showNotification(
        `Settings updated: ${
          this.maxConcurrentUploads
        } concurrent uploads, ${Math.floor(this.chunkSize / 1024)}KB chunks`,
        "success"
      );
      this.updateStatusCards();
      settingsModal.style.display = "none";

      // Restart queued uploads if new slots are available
      this.maybeStartNextUploads();
    });
  }

  setupViewToggle() {
    const listViewBtn = document.getElementById("list-view");
    const gridViewBtn = document.getElementById("grid-view");

    listViewBtn.addEventListener("click", () => {
      this.viewMode = "list";
      listViewBtn.classList.add("active");
      gridViewBtn.classList.remove("active");
      this.renderTransfers();
    });

    gridViewBtn.addEventListener("click", () => {
      this.viewMode = "grid";
      gridViewBtn.classList.add("active");
      listViewBtn.classList.remove("active");
      this.renderTransfers();
    });
  }

  setupTabs() {
    const tabs = document.querySelectorAll(".tab");
    const panels = ["all", "uploads", "downloads"];

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const targetPanel = tab
          .getAttribute("aria-controls")
          .replace("panel-", "");
        this.switchTab(targetPanel);
      });

      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const targetPanel = tab
            .getAttribute("aria-controls")
            .replace("panel-", "");
          this.switchTab(targetPanel);
        }
      });
    });
  }

  setupStatusCards() {
    const cards = document.querySelectorAll(".card");
    cards.forEach((card) => {
      card.addEventListener("click", () => {
        const cardType = card.dataset.type;
        // Map card types to tab names
        let tabName = "all";
        if (cardType === "active" || cardType === "completed") {
          tabName = "all"; // Show all transfers when clicking active/completed cards
        } else if (cardType === "total-files") {
          tabName = "all";
        } else if (cardType === "total-speed") {
          tabName = "uploads"; // Speed is mainly for uploads
        }
        this.switchTab(tabName);
      });
    });
  }

  switchTab(tabName) {
    // Update tab states
    const tabs = document.querySelectorAll(".tab");
    tabs.forEach((tab) => {
      tab.classList.remove("active");
      tab.setAttribute("aria-selected", "false");
      tab.setAttribute("tabindex", "-1");
    });

    const activeTab = document.getElementById(`tab-${tabName}`);
    if (activeTab) {
      activeTab.classList.add("active");
      activeTab.setAttribute("aria-selected", "true");
      activeTab.setAttribute("tabindex", "0");
    }

    this.activeTab = tabName;
    this.renderTransfers();
  }

  handleFileSelection(files) {
    if (!files || files.length === 0) return;

    console.log(`🎯 Starting upload of ${files.length} files`);

    Array.from(files).forEach((file, index) => {
      const transfer = {
        id: this.generateId(),
        name: file.name,
        size: file.size,
        type: "upload",
        status: "pending",
        progress: 0,
        speed: "0 KB/s",
        startTime: Date.now(),
        file: file,
        bytesSent: 0,
        lastTickBytes: 0,
        lastTickAt: performance.now(),
        currentSpeedBps: 0,
        _loopRunning: false,
      };

      this.transfers.push(transfer);
      console.log(
        `📎 Added file ${index + 1}/${files.length}: ${file.name} (ID: ${
          transfer.id
        })`
      );
    });

    const totalFiles = files.length;
    const activeUploads = this.countActiveUploads();
    const willBeQueued = Math.max(
      0,
      totalFiles - (this.maxConcurrentUploads - activeUploads)
    );

    console.log(
      `📊 Upload summary: ${totalFiles} files total, ${activeUploads} currently active, ${willBeQueued} will be queued`
    );
    console.log(`📊 Current transfers count: ${this.transfers.length}`);

    this.updateStatusCards();
    this.renderTransfers();

    if (totalFiles > 0) {
      if (willBeQueued > 0) {
        this.showNotification(
          `Đã thêm ${totalFiles} files. ${willBeQueued} files sẽ chờ trong queue (max ${this.maxConcurrentUploads} uploads đồng thời)`,
          "info"
        );
      } else {
        this.showNotification(
          `Đã thêm ${totalFiles} files. Tất cả sẽ bắt đầu upload ngay`,
          "success"
        );
      }
    }

    this.maybeStartNextUploads();
  }

  addDownloadURL() {
    const urlInput = document.getElementById("download-url");
    const url = urlInput.value.trim();

    if (!url) {
      this.showNotification("Please enter a valid URL", "error");
      return;
    }

    if (!this.isValidURL(url)) {
      this.showNotification("Please enter a valid URL format", "error");
      return;
    }

    const transfer = {
      id: this.generateId(),
      name: this.extractFileName(url),
      size: 0,
      type: "download",
      status: "pending",
      progress: 0,
      speed: "0 KB/s",
      startTime: Date.now(),
      url: url,
    };

    this.transfers.push(transfer);
    // Start real download
    this.realDownload(transfer);

    urlInput.value = "";
    this.updateStatusCards();
    this.renderTransfers();
    this.showNotification("Download added to queue", "success");
  }

  realDownload(transfer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log("WebSocket not ready for download");
      transfer.status = "error";
      this.renderTransfers();
      return;
    }

    transfer.status = "active";

    // Send download start message to WebSocket server
    this.ws.send(
      JSON.stringify({
        type: "download-start",
        sessionId: transfer.id,
        url: transfer.url,
        filename: transfer.name,
      })
    );

    this.renderTransfers();
    this.updateStatusCards();
  }

  renderTransfers() {
    // Prevent infinite recursion
    if (this._isRendering) return;
    this._isRendering = true;

    try {
      const noTransfersSection = document.querySelector(".no-transfers");

      // Chỉ re-render nếu cần thiết (thêm/xóa transfers hoặc thay đổi tab)
      const existingList = document.querySelector(
        ".transfers-list, .transfers-grid"
      );

      // FIX: Remove existing containers to prevent duplicates
      const existingContainers = document.querySelectorAll(
        ".transfers-container, .transfer-section, .transfers-scroll-wrapper"
      );
      existingContainers.forEach((container) => container.remove());

      let filteredTransfers = this.transfers;

      // Filter based on active tab
      if (this.activeTab === "uploads") {
        filteredTransfers = this.transfers.filter((t) => t.type === "upload");
      } else if (this.activeTab === "downloads") {
        filteredTransfers = this.transfers.filter((t) => t.type === "download");
      }

      if (filteredTransfers.length === 0) {
        if (noTransfersSection) {
          noTransfersSection.style.display = "block";
        }
        if (existingList) {
          existingList.remove();
        }
        return;
      }

      if (noTransfersSection) {
        noTransfersSection.style.display = "none";
      }

      // Group transfers by session type
      const currentSessionTransfers = filteredTransfers.filter(
        (t) =>
          t.isCurrentSession || (!t.isPreviousSession && !t.isCurrentSession)
      );
      const previousSessionTransfers = filteredTransfers.filter(
        (t) => t.isPreviousSession
      );

      // Sort current session transfers by upload time (newest first)
      currentSessionTransfers.sort((a, b) => {
        const timeA = new Date(a.uploadedAt || a.startTime || 0).getTime();
        const timeB = new Date(b.uploadedAt || b.startTime || 0).getTime();
        return timeB - timeA;
      });

      // Sort previous session transfers by upload time (newest first)
      previousSessionTransfers.sort(
        (a, b) => new Date(b.startTime) - new Date(a.startTime)
      );

      // Remove existing transfer list for complete re-render
      if (existingList) {
        existingList.remove();
      }

      // Create transfers container with scroll wrapper
      const transfersContainer = document.createElement("div");
      transfersContainer.className = "transfers-container";

      // Add scroll wrapper for the entire transfer area
      const scrollWrapper = document.createElement("div");
      scrollWrapper.className = "transfers-scroll-wrapper";

      // Create current session section if there are any
      if (currentSessionTransfers.length > 0) {
        const currentSection = this.createTransferSection(
          "Current Session",
          currentSessionTransfers,
          "current-session"
        );
        scrollWrapper.appendChild(currentSection);
      }

      // Create previous session section if there are any
      if (previousSessionTransfers.length > 0) {
        const previousSection = this.createTransferSection(
          "Previous Uploads",
          previousSessionTransfers,
          "previous-session"
        );
        scrollWrapper.appendChild(previousSection);
      }

      transfersContainer.appendChild(scrollWrapper);

      // Insert after tabs
      const tabsWrapper = document.querySelector(".tabs-wrapper");
      if (tabsWrapper && tabsWrapper.parentNode) {
        tabsWrapper.parentNode.insertBefore(
          transfersContainer,
          tabsWrapper.nextSibling
        );
      }
    } finally {
      this._isRendering = false;
    }
  }

  // Helper method to create transfer sections
  createTransferSection(title, transfers, sectionClass) {
    const section = document.createElement("div");
    section.className = `transfer-section ${sectionClass}`;

    // Create section header
    const header = document.createElement("div");
    header.className = "section-header";
    header.innerHTML = `
      <h3>${title}</h3>
      <span class="section-count">${transfers.length} file${
      transfers.length !== 1 ? "s" : ""
    }</span>
    `;
    section.appendChild(header);

    // Create transfers list với class phù hợp cho view mode
    const transfersList = document.createElement("div");
    const listClass =
      this.viewMode === "grid" ? "transfers-grid" : "transfers-list";
    transfersList.className = listClass;
    transfersList.setAttribute("aria-label", `${title} transfer list`);

    transfers.forEach((transfer) => {
      const transferItem = this.createTransferItem(transfer);
      transfersList.appendChild(transferItem);
    });

    section.appendChild(transfersList);
    return section;
  }

  // Update existing transfer items without full re-render
  updateExistingTransferItems(filteredTransfers) {
    // For now, we'll do a full re-render since the section structure is more complex
    // This can be optimized later if needed
    this._isRendering = false; // Reset flag
    this.renderTransfers(); // Full re-render
  }

  // Tạo transfers list mới mà không gọi renderTransfers
  createNewTransfersList(filteredTransfers) {
    const transfersList = document.createElement("section");
    const listClass =
      this.viewMode === "grid" ? "transfers-grid" : "transfers-list";
    transfersList.className = listClass;
    transfersList.setAttribute("aria-label", "Transfer list");

    filteredTransfers.forEach((transfer) => {
      const transferItem = this.createTransferItem(transfer);
      transfersList.appendChild(transferItem);
    });

    // Insert after tabs
    const tabsWrapper = document.querySelector(".tabs-wrapper");
    if (tabsWrapper && tabsWrapper.parentNode) {
      tabsWrapper.parentNode.insertBefore(
        transfersList,
        tabsWrapper.nextSibling
      );
    }
  }

  // Update action buttons for a specific transfer item
  updateTransferItemActions(item, transfer) {
    const actionsContainer = item.querySelector(".transfer-actions");
    if (!actionsContainer) return;

    // Kiểm tra xem status có thực sự thay đổi không
    const lastStatus = item.dataset.lastStatus;
    if (lastStatus === transfer.status) return; // Skip nếu status không đổi

    // Lưu status mới để so sánh lần sau
    item.dataset.lastStatus = transfer.status;

    // Update actions
    let actionButtons = this.getActionButtonsHTML(transfer);
    actionsContainer.innerHTML = actionButtons;

    // Re-attach event listeners
    this.attachActionListeners(item, transfer);
  }

  // Helper method to get action buttons HTML
  getActionButtonsHTML(transfer) {
    if (transfer.status === "completed") {
      // File đã hoàn thành, không cần nút nào
      return `<span class="status-text completed">✓ Completed</span>`;
    } else if (transfer.status === "uploading") {
      // Đang upload lên remote server, chỉ hiển thị status
      return `<span class="status-text">⬆ Uploading to server...</span>`;
    } else if (transfer.status === "completing") {
      // Đang finalize file local, chỉ hiển thị status
      return `<span class="status-text">⚡ Finalizing...</span>`;
    } else if (transfer.status === "pending") {
      return `
        <button class="action-btn start-btn" title="Start">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>
        <button class="action-btn stop-btn" title="Stop">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h12v12H6z"/>
          </svg>
        </button>`;
    } else if (transfer.status === "starting") {
      return `
        <button class="action-btn pause-btn" title="Starting..." disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
          </svg>
        </button>
        <button class="action-btn stop-btn" title="Stop">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h12v12H6z"/>
          </svg>
        </button>`;
    } else if (transfer.status === "active") {
      return `
        <button class="action-btn pause-btn" title="Pause">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
          </svg>
        </button>
        <button class="action-btn stop-btn" title="Stop">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h12v12H6z"/>
          </svg>
        </button>`;
    } else if (transfer.status === "paused") {
      return `
        <button class="action-btn resume-btn" title="Resume">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>
        <button class="action-btn stop-btn" title="Stop">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h12v12H6z"/>
          </svg>
        </button>`;
    } else if (transfer.status === "resuming") {
      return `
        <button class="action-btn resume-btn" title="Resuming..." disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>
        <button class="action-btn stop-btn" title="Stop">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h12v12H6z"/>
          </svg>
        </button>`;
    } else if (transfer.status === "error") {
      return `
        <button class="action-btn start-btn" title="Retry">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
          </svg>
        </button>
        <button class="action-btn stop-btn" title="Stop">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h12v12H6z"/>
          </svg>
        </button>`;
    } else if (transfer.status === "stopped") {
      return `
        <button class="action-btn start-btn" title="Restart">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>`;
    }
    return "";
  }

  // Helper method to attach event listeners
  attachActionListeners(item, transfer) {
    const startBtn = item.querySelector(".start-btn");
    const pauseBtn = item.querySelector(".pause-btn");
    const resumeBtn = item.querySelector(".resume-btn");
    const stopBtn = item.querySelector(".stop-btn");
    const restartBtn = item.querySelector(".restart-btn");
    const removeBtn = item.querySelector(".remove-btn");

    if (startBtn) {
      if (!startBtn._hasListener) {
        startBtn.addEventListener("click", () => this.startTransfer(transfer));
        startBtn._hasListener = true;
      }
    }
    if (pauseBtn) {
      if (!pauseBtn._hasListener) {
        pauseBtn.addEventListener("click", (e) => {
          // console.log("Pause button ACTUALLY clicked by user for:", transfer.id);
          // Prevent multiple rapid clicks
          if (pauseBtn._clicking) {
            // console.log("Pause click ignored - already processing");
            return;
          }
          pauseBtn._clicking = true;
          setTimeout(() => (pauseBtn._clicking = false), 1000);

          this.pauseTransfer(transfer);
        });
        pauseBtn._hasListener = true;
      }
    }
    if (resumeBtn) {
      if (!resumeBtn._hasListener) {
        resumeBtn.addEventListener("click", () =>
          this.resumeTransfer(transfer)
        );
        resumeBtn._hasListener = true;
      }
    }
    if (stopBtn) {
      if (!stopBtn._hasListener) {
        stopBtn.addEventListener("click", () => this.stopTransfer(transfer));
        stopBtn._hasListener = true;
      }
    }
    // FIX: Add event listeners for new buttons
    if (restartBtn) {
      if (!restartBtn._hasListener) {
        restartBtn.addEventListener("click", () =>
          this.restartTransfer(transfer)
        );
        restartBtn._hasListener = true;
      }
    }
    if (removeBtn) {
      if (!removeBtn._hasListener) {
        removeBtn.addEventListener("click", () =>
          this.removeTransfer(transfer)
        );
        removeBtn._hasListener = true;
      }
    }
  }

  // Helper method to get appropriate speed display based on transfer status
  getDisplaySpeed(transfer) {
    switch (transfer.status) {
      case "completed":
        // For completed files, show "Completed" instead of "0 B/s"
        return "Completed";
      case "error":
        return "Error";
      case "pending":
        return "Pending";
      case "paused":
        return "Paused";
      case "stopped":
        return "Stopped";
      case "active":
      case "uploading":
      case "starting":
        // For active transfers, show actual speed
        return transfer.speed || "0 B/s";
      default:
        return transfer.speed || "—";
    }
  }

  createTransferItem(transfer) {
    const item = document.createElement("div");
    item.className = `transfer-item ${transfer.status}`;
    // Add class for existing files
    if (transfer.isPreviousSession) {
      item.className += " previous-session";
    }
    item.setAttribute("data-id", transfer.id);
    item.setAttribute("data-transfer-id", transfer.id); // Thêm để optimize update
    item.dataset.lastStatus = transfer.status; // Lưu status để so sánh sau

    const statusIcon = this.getStatusIcon(transfer.status);
    const progressBar = this.createProgressBar(transfer.progress);

    // Create time indicator for completed files
    const timeIndicator =
      transfer.status === "completed" && transfer.uploadTimeDisplay
        ? `<div class="time-indicator" title="Uploaded: ${transfer.uploadTimeDisplay}">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
           <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-.5-13H10v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>
         </svg>
         ${transfer.uploadTimeDisplay}
       </div>`
        : "";

    // Xác định nút nào cần hiển thị dựa trên status
    let actionButtons = "";

    if (transfer.status === "completed") {
      // File đã hoàn thành - có nút Restart để upload lại
      actionButtons = `
                <button class="action-btn restart-btn" title="Upload this file again">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M4 12a8 8 0 0 1 7.89-8 7.85 7.85 0 0 1 5.44 2.2l.39.39a.85.85 0 0 1 0 1.22l-.39.39a.85.85 0 0 1-1.22 0l-.39-.39A6 6 0 1 0 18 12a.85.85 0 0 1 .85-.85.85.85 0 0 1 .85.85 8 8 0 1 1-15.7 0z"/>
                        <path d="m23 3-6 6 2 2z"/>
                    </svg>
                    Upload Again
                </button>
                <button class="action-btn remove-btn" title="Delete file (move to recycle bin)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                    Delete
                </button>
            `;
    } else if (transfer.status === "pending") {
      // File đang chờ - có nút Start
      actionButtons = `
                <button class="action-btn start-btn" title="Start">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </button>
                <button class="action-btn stop-btn" title="Stop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
                </button>
            `;
    } else if (transfer.status === "starting") {
      // File đang bắt đầu - hiển thị Pause (disabled) và Stop
      actionButtons = `
                <button class="action-btn pause-btn" title="Starting..." disabled>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                    </svg>
                </button>
                <button class="action-btn stop-btn" title="Stop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
                </button>
            `;
    } else if (transfer.status === "active") {
      // File đang upload - có nút Pause và Stop
      actionButtons = `
                <button class="action-btn pause-btn" title="Pause">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                    </svg>
                </button>
                <button class="action-btn stop-btn" title="Stop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
                </button>
            `;
    } else if (transfer.status === "paused") {
      // File đã pause - có nút Resume và Stop
      actionButtons = `
                <button class="action-btn resume-btn" title="Resume">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </button>
                <button class="action-btn stop-btn" title="Stop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
                </button>
            `;
    } else if (transfer.status === "resuming") {
      // File đang resuming - nút Resume disabled
      actionButtons = `
                <button class="action-btn resume-btn" title="Resuming..." disabled>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </button>
                <button class="action-btn stop-btn" title="Stop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
                </button>
            `;
    } else if (transfer.status === "error") {
      // File có lỗi - có nút Start (retry) và Stop
      actionButtons = `
                <button class="action-btn start-btn" title="Retry">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                    </svg>
                </button>
                <button class="action-btn stop-btn" title="Stop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
                </button>
            `;
    }

    // Tạo layout khác nhau cho grid và list view
    if (this.viewMode === "grid") {
      item.innerHTML = `
        <div class="transfer-header">
          <div class="transfer-icon">${statusIcon}</div>
          <div class="transfer-info">
            <div class="transfer-name">${transfer.name}</div>
            <div class="transfer-size">${this.formatFileSize(
              transfer.size
            )}</div>
            ${timeIndicator}
          </div>
        </div>
        <div class="progress-container">
          ${progressBar}
          <div class="progress-text">
            <span>${Math.round(transfer.progress)}%</span>
            <span class="transfer-speed">${this.getDisplaySpeed(
              transfer
            )}</span>
          </div>
        </div>
        <div class="action-buttons">
          ${actionButtons}
        </div>
      `;
    } else {
      // List view layout (original)
      item.innerHTML = `
        <div class="transfer-info">
          <div class="transfer-icon">${statusIcon}</div>
          <div class="transfer-details">
            <div class="transfer-name-row">
              <div class="transfer-name">${transfer.name}</div>
              ${timeIndicator}
            </div>
            <div class="transfer-meta">
              <span class="transfer-size">${this.formatFileSize(
                transfer.size
              )}</span>
              <span class="transfer-speed">${this.getDisplaySpeed(
                transfer
              )}</span>
            </div>
          </div>
        </div>
        <div class="transfer-progress">
          ${progressBar}
          <div class="transfer-percentage">${Math.round(
            transfer.progress
          )}%</div>
        </div>
        <div class="transfer-actions">
          ${actionButtons}
        </div>
      `;
    }

    // Add event listeners
    const startBtn = item.querySelector(".start-btn");
    const pauseBtn = item.querySelector(".pause-btn");
    const resumeBtn = item.querySelector(".resume-btn");
    const stopBtn = item.querySelector(".stop-btn");

    if (startBtn && !startBtn._hasListener) {
      startBtn.addEventListener("click", () => this.startTransfer(transfer));
      startBtn._hasListener = true;
    }

    if (pauseBtn && !pauseBtn._hasListener) {
      pauseBtn.addEventListener("click", (e) => {
        // console.log("List view pause button ACTUALLY clicked by user for:", transfer.id);
        // Prevent multiple rapid clicks
        if (pauseBtn._clicking) {
          // console.log("List pause click ignored - already processing");
          return;
        }
        pauseBtn._clicking = true;
        setTimeout(() => (pauseBtn._clicking = false), 1000);

        this.pauseTransfer(transfer);
      });
      pauseBtn._hasListener = true;
    }

    if (resumeBtn && !resumeBtn._hasListener) {
      resumeBtn.addEventListener("click", (e) => {
        console.log(
          "Resume button clicked for:",
          transfer.id,
          "Status:",
          transfer.status
        );
        if (!resumeBtn.disabled) {
          this.resumeTransfer(transfer);
        }
      });
      resumeBtn._hasListener = true;
    }

    if (stopBtn && !stopBtn._hasListener) {
      stopBtn.addEventListener("click", () => this.stopTransfer(transfer));
      stopBtn._hasListener = true;
    }

    // CRITICAL FIX: Gắn event listeners cho tất cả buttons
    this.attachActionListeners(item, transfer);

    return item;
  }

  createProgressBar(progress) {
    return `
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
        `;
  }

  getStatusIcon(status) {
    const icons = {
      pending:
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
      active:
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
      completed:
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
      paused:
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
      error:
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
    };
    return icons[status] || icons.pending;
  }

  updateStatusCards() {
    const activeTransfers = this.transfers.filter((t) => t.status === "active");
    const completedTransfers = this.transfers.filter(
      (t) => t.status === "completed"
    );
    const queuedTransfers = this.transfers.filter(
      (t) => t.status === "pending" || t.status === "queued"
    );
    const totalFiles = this.transfers.length;
    const totalSpeed = this.calculateTotalSpeed();

    // Update status card values
    this.updateStatusCard("active", activeTransfers.length);
    this.updateStatusCard("completed", completedTransfers.length);
    this.updateStatusCard("total-files", totalFiles);
    this.updateStatusCard("total-speed", totalSpeed);

    // Cập nhật thông tin upload đồng thời với queue info
    const activeCount = document.getElementById("active-count");
    const maxConcurrent = document.getElementById("max-concurrent");
    if (activeCount) {
      if (queuedTransfers.length > 0) {
        activeCount.textContent = `${activeTransfers.length} (+${queuedTransfers.length} queue)`;
      } else {
        activeCount.textContent = activeTransfers.length;
      }
    }
    if (maxConcurrent) maxConcurrent.textContent = this.maxConcurrentUploads;
  }

  // FIX: Add method to fetch and update dashboard stats from backend
  async refreshDashboardStats() {
    // Upload page stats based on current session only, not backend data
    const activeTransfers = this.transfers.filter(
      (t) =>
        t.status === "active" ||
        t.status === "uploading" ||
        t.status === "paused"
    );
    const completedTransfers = this.transfers.filter(
      (t) => t.status === "completed"
    );
    const totalTransfers = this.transfers.length;

    // Calculate total speed from active transfers
    const totalSpeed = activeTransfers.reduce((sum, t) => {
      const speedMatch = t.speed?.match(/(\d+(?:\.\d+)?)\s*([KMGT]?B)/);
      if (speedMatch) {
        const value = parseFloat(speedMatch[1]);
        const unit = speedMatch[2];
        const multipliers = {
          B: 1,
          KB: 1024,
          MB: 1024 * 1024,
          GB: 1024 * 1024 * 1024,
          TB: 1024 * 1024 * 1024 * 1024,
        };
        return sum + value * (multipliers[unit] || 1);
      }
      return sum;
    }, 0);

    // Update cards with current session data
    this.updateStatusCard("active", activeTransfers.length);
    this.updateStatusCard("completed", completedTransfers.length);
    this.updateStatusCard("total", totalTransfers);
    this.updateStatusCard("speed", this.formatFileSize(totalSpeed) + "/s");

    console.log(
      `📊 Current session stats: ${activeTransfers.length} active, ${completedTransfers.length} completed, ${totalTransfers} total`
    );
  }

  updateStatusCard(type, value) {
    const card = document.querySelector(`[data-type="${type}"]`);
    if (card) {
      const valueElement = card.querySelector(".card-text span:last-child");
      if (valueElement) {
        if (type === "total-speed") {
          valueElement.textContent = value;
        } else {
          valueElement.innerHTML = `<b>${value}</b>`;
        }
      }
    }
  }

  calculateTotalSpeed() {
    const activeTransfers = this.transfers.filter((t) => t.status === "active");
    if (activeTransfers.length === 0) return "0 KB/s";

    // Tính tổng tốc độ từ tất cả transfer đang active
    let totalBps = 0;
    activeTransfers.forEach((transfer) => {
      // Sử dụng currentSpeedBps nếu có, nếu không thì tính toán
      if (transfer.currentSpeedBps && transfer.currentSpeedBps > 0) {
        totalBps += transfer.currentSpeedBps;
      } else {
        const speed = this.computeInstantSpeed(transfer);
        if (speed > 0) {
          totalBps += speed;
        }
      }
    });

    if (totalBps === 0) return "0 KB/s";
    return this.formatSpeed(totalBps);
  }

  startTransfer(transfer) {
    if (transfer.type === "upload") {
      if (["pending", "error", "queued"].includes(transfer.status)) {
        // Tôn trọng giới hạn đồng thời
        if (this.countActiveUploads() >= this.maxConcurrentUploads) {
          transfer.status = "queued";
          this.showNotification(
            `File được xếp hàng (${this.countActiveUploads()}/${
              this.maxConcurrentUploads
            } slots đang được sử dụng)`,
            "info"
          );
          this.renderTransfers();
          return;
        }
        // Chỉ gửi 'start', CHƯA upload cho đến khi có start-ack
        transfer.status = "starting";
        this.send({
          action: "start",
          fileId: transfer.id,
          fileName: transfer.name,
          fileSize: transfer.size,
        });
      }
    } else {
      // real download
      if (transfer.status === "pending" || transfer.status === "error") {
        this.realDownload(transfer);
      }
    }
    this.renderTransfers();
  }

  pauseTransfer(transfer) {
    // console.log("pauseTransfer called for:", transfer.id, "current status:", transfer.status);
    // console.trace("pauseTransfer call stack"); // Shows who called this function

    if (transfer.type === "upload") {
      if (transfer.status === "active") {
        // CRITICAL FIX: Clear any pending resume timeout
        if (transfer._resumeTimeoutId) {
          clearTimeout(transfer._resumeTimeoutId);
          transfer._resumeTimeoutId = null;
        }

        transfer.status = "paused";
        transfer._stopCurrentLoop = true; // Dừng upload loop
        transfer._resuming = false; // Reset resuming flag
        // console.log("Sending pause command to server for:", transfer.id);
        this.send({ action: "pause", fileId: transfer.id });
      }
    } else if (transfer.type === "download") {
      // For real downloads
      if (transfer.status === "active") {
        transfer.status = "paused";
        this.send({
          type: "download-pause",
          sessionId: transfer.id,
        });
      }
    }
    this.throttledRender();
  }

  resumeTransfer(transfer) {
    // console.log("resumeTransfer called with:", transfer.id, "current status:", transfer.status);

    // CRITICAL FIX: Stronger debounce to prevent race conditions
    if (transfer._resuming || transfer._loopRunning) {
      console.log("Resume ignored - already in progress or loop running");
      return;
    }

    if (transfer.type === "download") {
      // Real downloads
      if (transfer.status === "paused") {
        transfer.status = "active";
        this.send({
          type: "download-resume",
          sessionId: transfer.id,
        });
        // Throttle render để tránh giật
        this.throttledRender();
      }
      return;
    }

    if (transfer.status !== "paused") {
      console.log(
        "Cannot resume - transfer not paused. Current status:",
        transfer.status
      );
      return;
    }

    if (this.countActiveUploads() >= this.maxConcurrentUploads) {
      transfer.status = "queued";
      this.showNotification(
        `Upload được xếp hàng (${this.countActiveUploads()}/${
          this.maxConcurrentUploads
        } slots đang được sử dụng)`,
        "info"
      );
      this.throttledRender();
      return;
    }

    console.log("Starting resume process for:", transfer.id);

    // CRITICAL FIX: Set stronger locks to prevent race conditions
    transfer._resuming = true;
    transfer._stopCurrentLoop = false; // Reset stop flag

    // Smooth transition: Set intermediate state trước
    transfer.status = "resuming";
    this.renderTransfers(); // Force immediate render

    // Gửi resume command
    console.log("Sending resume command to server for:", transfer.id);
    this.send({ action: "resume", fileId: transfer.id });

    // CRITICAL FIX: Improved fallback with better state management
    const timeoutId = setTimeout(() => {
      if (transfer.status === "resuming" && transfer._resuming) {
        console.log(
          "Resume-ack timeout, starting upload manually for:",
          transfer.id
        );
        transfer.status = "active";
        transfer._resuming = false; // Reset flag
        this.renderTransfers();

        // Only start upload loop if no other loop is running
        if (!transfer._loopRunning) {
          setTimeout(() => {
            this.uploadLoop(transfer);
          }, 50);
        }
      }
    }, 3000); // Increased timeout to 3 seconds

    // Store timeout ID to cancel it if resume-ack arrives
    transfer._resumeTimeoutId = timeoutId;
  }

  stopTransfer(transfer) {
    if (transfer.type === "upload") {
      // CRITICAL FIX: Clean up all state properly
      if (transfer._resumeTimeoutId) {
        clearTimeout(transfer._resumeTimeoutId);
        transfer._resumeTimeoutId = null;
      }

      // Đặt trạng thái stopped và dừng loop ngay lập tức
      transfer.status = "stopped";
      transfer._stopCurrentLoop = true; // Dừng upload loop ngay lập tức
      transfer._resuming = false; // Reset resuming flag
      transfer._waitingForAck = false; // Reset waiting flag
      transfer.progress = Math.min(
        100,
        (transfer.bytesSent / Math.max(transfer.size, 1)) * 100
      );

      // Chờ một chút để đảm bảo upload loop đã dừng hoàn toàn
      setTimeout(() => {
        // Gửi lệnh stop đến server sau khi loop đã dừng
        this.send({ action: "stop", fileId: transfer.id, delete: true });
      }, 50);

      // Cập nhật UI ngay lập tức để hiển thị trạng thái stopped
      this.renderTransfers();
      this.updateStatusCards();

      // Thử start các pending khác sau khi stop
      this.maybeStartNextUploads();
    } else if (transfer.type === "download") {
      // For real downloads
      this.send({
        type: "download-stop",
        sessionId: transfer.id,
      });

      // Remove from transfers immediately
      const index = this.transfers.findIndex((t) => t.id === transfer.id);
      if (index > -1) {
        this.transfers.splice(index, 1);
        this.updateStatusCards();
        this.renderTransfers();
      }
    }
  }

  // FIX: Add restart functionality for completed files
  restartTransfer(transfer) {
    if (!transfer) {
      console.warn("restartTransfer called with invalid transfer");
      return;
    }

    console.log(
      "RESTART: Starting restart for:",
      transfer.name,
      "current status:",
      transfer.status
    );

    if (transfer.type === "upload") {
      // For previous session files, create a new transfer
      if (transfer.isPreviousSession || transfer.status === "completed") {
        // Create a completely new transfer with new ID
        const newTransfer = {
          id: this.generateId(),
          name: transfer.name,
          size: transfer.size,
          type: "upload",
          status: "pending",
          progress: 0,
          speed: "0 KB/s",
          bytesSent: 0,
          lastTickBytes: 0,
          lastTickAt: performance.now(),
          retryCount: 0,
          file: transfer.file, // Need the original file object

          // Clean state
          _stopCurrentLoop: false,
          _loopRunning: false,
          _loopId: null,
          _waitingForAck: false,
          _resuming: false,

          // Mark as current session
          isPreviousSession: false,
        };

        // For files without file object, trigger file picker
        if (!transfer.file) {
          this.showNotification(
            "Please select the file again to re-upload",
            "warning"
          );
          // Trigger file picker for this specific file
          this.triggerFilePickerForRestart(transfer, newTransfer);
          return;
        }

        // Add to transfers array
        this.transfers.push(newTransfer);

        this.showNotification(
          `Added ${transfer.name} to upload queue`,
          "success"
        );
        this.renderTransfers();
        this.maybeStartNextUploads();
      } else {
        // For current session files, just reset state
        if (!transfer.file) {
          console.warn(
            "Current session file missing file object, triggering file picker"
          );
          // Same as previous session - need to pick file again
          const newTransfer = {
            id: this.generateId(),
            name: transfer.name,
            size: transfer.size,
            type: "upload",
            status: "pending",
            progress: 0,
            speed: "0 KB/s",
            bytesSent: 0,
            lastTickBytes: 0,
            lastTickAt: performance.now(),
            retryCount: 0,
            file: null, // Will be set by file picker

            // Clean state
            _stopCurrentLoop: false,
            _loopRunning: false,
            _loopId: null,
            _waitingForAck: false,
            _resuming: false,

            // Mark as current session
            isPreviousSession: false,
            isCurrentSession: true,
          };

          this.showNotification(
            "Please select the file again to re-upload",
            "warning"
          );
          this.triggerFilePickerForRestart(transfer, newTransfer);
          return;
        } else if (transfer.file) {
          // Current Session files WITH file object - can reset directly
          const newTransfer = {
            // Copy essential fields
            ...transfer,
            id: transfer.id + "_restart_" + Date.now(),
            size: transfer.size,
            type: "upload",
            status: "pending",
            progress: 0,
            speed: "0 KB/s",
            bytesSent: 0,
            lastTickBytes: 0,
            lastTickAt: performance.now(),
            retryCount: 0,

            // Clean state
            _stopCurrentLoop: false,
            _loopRunning: false,
            _loopId: null,
            _waitingForAck: false,
            _resuming: false,

            // Keep file object and session status
            file: transfer.file,
            isPreviousSession: false,
            isCurrentSession: true,
          };

          // Remove old transfer and add new one
          this.removeFileTransfer(transferId);
          this.addOrUpdateTransfer(newTransfer);
          this.saveTransfersToStorage();
          this.showNotification(
            `Restarting upload for ${transfer.name}`,
            "info"
          );
          return;
        } else {
          // Current Session files WITHOUT file object - also need file picker
          const newTransfer = {
            // Copy essential fields
            ...transfer,
            id: transfer.id + "_restart_" + Date.now(),
            size: transfer.size,
            type: "upload",
            status: "pending",
            progress: 0,
            speed: "0 KB/s",
            bytesSent: 0,
            lastTickBytes: 0,
            lastTickAt: performance.now(),
            retryCount: 0,
            file: null, // Will be set by file picker

            // Clean state
            _stopCurrentLoop: false,
            _loopRunning: false,
            _loopId: null,
            _waitingForAck: false,
            _resuming: false,

            // Mark as current session
            isPreviousSession: false,
            isCurrentSession: true,
          };

          this.showNotification(
            "Please select the file again to re-upload",
            "warning"
          );
          this.triggerFilePickerForRestart(transfer, newTransfer);
          return;
        }
      }
    } else if (transfer.type === "download") {
      // Reset download state
      transfer.status = "pending";
      transfer.progress = 0;
      transfer.bytesReceived = 0;
      transfer.speed = "0 KB/s";
      delete transfer.error;

      this.showNotification(`Restarting download: ${transfer.name}`, "info");
      this.renderTransfers();
      this.startTransfer(transfer);
    }
  }

  // Helper method to trigger file picker for restart
  triggerFilePickerForRestart(originalTransfer, newTransfer) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "*/*";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (
        file &&
        file.name === originalTransfer.name &&
        file.size === originalTransfer.size
      ) {
        newTransfer.file = file;
        this.transfers.push(newTransfer);
        this.showNotification(`Added ${file.name} to upload queue`, "success");
        this.renderTransfers();
        this.maybeStartNextUploads();
      } else if (file) {
        this.showNotification(
          `File mismatch. Expected: ${
            originalTransfer.name
          } (${this.formatFileSize(originalTransfer.size)})`,
          "error"
        );
      }
    };
    input.click();
  }

  // FIX: Add remove functionality for completed/stopped files
  async removeTransfer(transfer) {
    if (!transfer) {
      console.warn("removeTransfer called with invalid transfer");
      return;
    }

    console.log(
      "REMOVE: Attempting to remove:",
      transfer.name,
      "status:",
      transfer.status
    );

    // Only allow removal of completed, stopped, or error states
    if (!["completed", "stopped", "error"].includes(transfer.status)) {
      this.showNotification(
        "Can only remove completed, stopped, or failed transfers",
        "warning"
      );
      return;
    }

    // Show confirmation for important files
    if (transfer.isPreviousSession || transfer.status === "completed") {
      const confirmMsg = `Delete "${transfer.name}"?\n\nThis will move the file to recycle bin. You can restore it later if needed.`;
      if (!confirm(confirmMsg)) {
        return;
      }
    }

    // FIX: If this is a previous session file (has fileId), delete from server database
    if (transfer.isPreviousSession && transfer.fileId) {
      try {
        console.log(
          "REMOVE: Deleting from server database, fileId:",
          transfer.fileId
        );
        console.log(
          "REMOVE: Using auth token:",
          this.authToken ? this.authToken.substring(0, 20) + "..." : "None"
        );

        const response = await fetch(
          `http://localhost:5000/api/files/${transfer.fileId}`,
          {
            method: "DELETE",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.authToken}`,
            },
          }
        );

        console.log(
          "REMOVE: Response status:",
          response.status,
          response.statusText
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error("REMOVE: Server error response:", errorText);
          throw new Error(
            `Server responded with ${response.status}: ${response.statusText}`
          );
        }

        const result = await response.json();
        console.log("REMOVE: Server response:", result);

        this.showNotification(
          `Moved "${transfer.name}" to recycle bin`,
          "success"
        );
      } catch (error) {
        console.error("REMOVE: Error deleting from server:", error);
        this.showNotification(
          `Failed to delete from server: ${error.message}`,
          "error"
        );
        return; // Don't remove from frontend if server deletion failed
      }
    }

    // Remove from transfers array
    const index = this.transfers.findIndex((t) => t.id === transfer.id);
    if (index > -1) {
      this.transfers.splice(index, 1);

      // Remove from sessionStorage as well
      this.removeFileFromSession(transfer.id, transfer.name);

      // Only show notification if we didn't delete from server (to avoid double notifications)
      if (!transfer.isPreviousSession || !transfer.fileId) {
        this.showNotification(
          `Removed "${transfer.name}" from list`,
          "success"
        );
      }

      this.renderTransfers();
      this.updateStatusCards();
      await this.refreshDashboardStats(); // FIX: Refresh real stats after deletion

      console.log(
        "REMOVE: Successfully removed transfer. Remaining transfers:",
        this.transfers.length
      );
    } else {
      console.warn("REMOVE: Transfer not found in array");
      this.showNotification("Transfer not found", "error");
    }
  }

  // Legacy method - keep for backward compatibility
  togglePause(transfer) {
    if (transfer.status === "active") {
      this.pauseTransfer(transfer);
    } else if (transfer.status === "paused") {
      this.resumeTransfer(transfer);
    }
  }

  // Legacy method - keep for backward compatibility
  cancelTransfer(transfer) {
    this.stopTransfer(transfer);
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }

  isValidURL(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  extractFileName(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const fileName = pathname.split("/").pop();
      return fileName || "download";
    } catch {
      return "download";
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond === 0) return "0 KB/s";
    const k = 1024;
    const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return (
      parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
    );
  }

  showNotification(message, type = "info") {
    // Create notification element
    const notification = document.createElement("div");
    notification.className = `notification ${type}`;
    notification.textContent = message;

    // Add to page
    document.body.appendChild(notification);

    // Remove after 3 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  }

  // Format upload time cho display
  formatUploadTime(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24)
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;

    // For older files, show actual date
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  }

  // Trả về số upload đang active
  countActiveUploads() {
    return this.transfers.filter(
      (t) => t.type === "upload" && t.status === "active"
    ).length;
  }

  // Bắt đầu các upload đang pending nếu còn slot trống
  maybeStartNextUploads() {
    let active = this.countActiveUploads();
    if (active >= this.maxConcurrentUploads) return;

    const pendingList = this.transfers.filter(
      (t) =>
        t.type === "upload" && (t.status === "pending" || t.status === "queued")
    );

    if (pendingList.length > 0) {
      const slotsAvailable = this.maxConcurrentUploads - active;
      const willStart = Math.min(pendingList.length, slotsAvailable);
      const remainInQueue = pendingList.length - willStart;

      if (active === 0) {
        // Lần đầu bắt đầu uploads
        this.showNotification(
          `Bắt đầu upload ${willStart} files đồng thời${
            remainInQueue > 0 ? `, ${remainInQueue} files chờ trong queue` : ""
          }`,
          "info"
        );
      } else if (willStart > 0) {
        // Bắt đầu uploads từ queue sau khi có slot trống
        this.showNotification(
          `Bắt đầu upload ${willStart} files từ queue${
            remainInQueue > 0 ? `, còn ${remainInQueue} files chờ` : ""
          }`,
          "info"
        );
      }
    }

    for (const t of pendingList) {
      if (active >= this.maxConcurrentUploads) break;
      this.startUpload(t);
      active += 1;
    }
  }
}

// Initialize the application when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  window.flexTransferHub = new FlexTransferHub();
});

// Export for potential module usage
if (typeof module !== "undefined" && module.exports) {
  module.exports = FlexTransferHub;
}
