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
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.setupDragAndDrop();
    this.setupSettingsModal();
    this.setupViewToggle();
    this.updateStatusCards();
    this.renderTransfers();
    this.connectWebSocket();
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
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.showNotification("Connected to upload server", "success");
        this.maybeStartNextUploads(); // bật lại các job đang chờ, tôn trọng limit
      };

      this.ws.onmessage = (ev) => this.handleWSMessage(ev);

      this.ws.onclose = () => {
        this.showNotification("Disconnected from upload server", "error");
        this.transfers.forEach((t) => {
          if (t.type === "upload" && t.status === "active") t.status = "queued";
        });
        this.renderTransfers();
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
      setTimeout(() => this.connectWebSocket(), 3000);
    }
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

        // Start upload loop với delay nhỏ để UI smooth
        setTimeout(() => {
          console.log("Starting upload loop for resumed transfer:", fileId);
          this.uploadLoop(transfer);
        }, 50);
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
        if (!transfer) {
          console.warn("Received complete-ack for unknown transfer:", fileId);
          return;
        }
        transfer.status = "completed";
        transfer.progress = 100;
        transfer.speed = "0 KB/s";
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
        if (!transfer) {
          console.warn("Received completed for unknown transfer:", fileId);
          return;
        }
        transfer.status = "completed";
        transfer.progress = 100;
        transfer.speed = "0 KB/s";
        transfer.remoteFileId = msg.remoteFileId;
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

    // Update UI immediately to show correct buttons
    this.renderTransfers();

    await this.ensureSocketOpen();
    this.send({
      action: "start",
      fileId: transfer.id,
      fileName: transfer.name,
      fileSize: transfer.size,
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

    // không cho chạy 2 vòng lặp cùng lúc
    if (transfer._loopRunning) {
      console.log("uploadLoop exiting - already running");
      return;
    }
    transfer._loopRunning = true;
    console.log("uploadLoop starting for:", transfer.id);

    try {
      while (
        transfer.status === "active" &&
        transfer.bytesSent < transfer.size &&
        !transfer._stopCurrentLoop // Kiểm tra flag để dừng loop
      ) {
        const start = transfer.bytesSent; // luôn lấy offset mới nhất
        const end = Math.min(start + this.chunkSize, transfer.size);
        const slice = transfer.file.slice(start, end);
        const buffer = await slice.arrayBuffer();
        const base64 = this.arrayBufferToBase64(buffer);

        // Kiểm tra lại status trước khi gửi chunk (có thể đã bị stop)
        if (transfer.status !== "active" || transfer._stopCurrentLoop) {
          console.log("Upload stopped before sending chunk, breaking loop");
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
          waitCount < maxWaitTime
        ) {
          await new Promise((r) => setTimeout(r, 100)); // Wait 100ms
          waitCount++;
        }

        // Nếu timeout hoặc stopped, break
        if (waitCount >= maxWaitTime) {
          console.warn(
            `Timeout waiting for chunk-ack after ${
              maxWaitTime * 100
            }ms, breaking upload loop`
          );
          transfer._waitingForAck = false;
          transfer.status = "error";
          transfer.error = "Server response timeout";
          this.renderTransfers();
          break;
        }
        if (transfer.status !== "active" || transfer._stopCurrentLoop) {
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
      transfer._loopRunning = false;
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

    Array.from(files).forEach((file) => {
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
    });

    this.updateStatusCards();
    this.renderTransfers();
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

      // Nếu đã có list và số lượng transfers không đổi và view mode không đổi, chỉ update status
      if (
        existingList &&
        existingList.children.length === filteredTransfers.length &&
        ((this.viewMode === "grid" &&
          existingList.classList.contains("transfers-grid")) ||
          (this.viewMode === "list" &&
            existingList.classList.contains("transfers-list")))
      ) {
        this.updateExistingTransferItems(filteredTransfers);
        return;
      }

      // Remove existing transfer list nếu cần re-render hoàn toàn
      if (existingList) {
        existingList.remove();
      }

      // Create transfers list với class phù hợp cho view mode
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
    } finally {
      this._isRendering = false;
    }
  }

  // Update existing transfer items without full re-render
  updateExistingTransferItems(filteredTransfers) {
    const existingList = document.querySelector(
      ".transfers-list, .transfers-grid"
    );
    if (!existingList) return;

    const existingItems = existingList.children;

    filteredTransfers.forEach((transfer, index) => {
      if (index < existingItems.length) {
        const item = existingItems[index];

        // Update status class
        item.className = `transfer-item ${transfer.status}`;

        // Update progress bar và percentage
        const progressFill = item.querySelector(".progress-fill");
        const progressElement = item.querySelector(".transfer-percentage");
        if (progressFill) {
          progressFill.style.width = `${transfer.progress}%`;
        }
        if (progressElement) {
          progressElement.textContent = `${Math.round(transfer.progress)}%`;
        }

        // Update speed
        const speedElement = item.querySelector(".transfer-speed");
        if (speedElement) {
          speedElement.textContent = transfer.speed || "0 KB/s";
        }

        // Update action buttons nếu status thay đổi
        const currentDataId = item.getAttribute("data-transfer-id");
        if (currentDataId === transfer.id) {
          this.updateTransferItemActions(item, transfer);
        }
      }
    });
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
  }

  createTransferItem(transfer) {
    const item = document.createElement("div");
    item.className = `transfer-item ${transfer.status}`;
    item.setAttribute("data-id", transfer.id);
    item.setAttribute("data-transfer-id", transfer.id); // Thêm để optimize update
    item.dataset.lastStatus = transfer.status; // Lưu status để so sánh sau

    const statusIcon = this.getStatusIcon(transfer.status);
    const progressBar = this.createProgressBar(transfer.progress);

    // Xác định nút nào cần hiển thị dựa trên status
    let actionButtons = "";

    if (transfer.status === "completed") {
      // File đã hoàn thành - chỉ có nút Stop
      actionButtons = `
                <button class="action-btn stop-btn" title="Stop">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
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
          </div>
        </div>
        <div class="progress-container">
          ${progressBar}
          <div class="progress-text">
            <span>${Math.round(transfer.progress)}%</span>
            <span class="transfer-speed">${transfer.speed}</span>
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
            <div class="transfer-name">${transfer.name}</div>
            <div class="transfer-meta">
              <span class="transfer-size">${this.formatFileSize(
                transfer.size
              )}</span>
              <span class="transfer-speed">${transfer.speed}</span>
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
    const totalFiles = this.transfers.length;
    const totalSpeed = this.calculateTotalSpeed();

    // Update status card values
    this.updateStatusCard("active", activeTransfers.length);
    this.updateStatusCard("completed", completedTransfers.length);
    this.updateStatusCard("total-files", totalFiles);
    this.updateStatusCard("total-speed", totalSpeed);

    // Cập nhật thông tin upload đồng thời
    const activeCount = document.getElementById("active-count");
    const maxConcurrent = document.getElementById("max-concurrent");
    if (activeCount) activeCount.textContent = activeTransfers.length;
    if (maxConcurrent) maxConcurrent.textContent = this.maxConcurrentUploads;
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
        transfer.status = "paused";
        transfer._stopCurrentLoop = true; // Dừng upload loop
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

    // Debounce để tránh multiple calls
    if (transfer._resuming) {
      // console.log("Resume already in progress, ignoring");
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

    // Set flag để tránh duplicate calls
    transfer._resuming = true;

    // Smooth transition: Set intermediate state trước
    transfer.status = "resuming";
    transfer._stopCurrentLoop = false; // Reset stop flag
    this.renderTransfers(); // Force immediate render

    // Gửi resume command
    console.log("Sending resume command to server for:", transfer.id);
    this.send({ action: "resume", fileId: transfer.id });

    // Fallback: Nếu không nhận được resume-ack sau 2 giây, tự động bắt đầu
    setTimeout(() => {
      if (transfer.status === "resuming") {
        console.log(
          "Resume-ack timeout, starting upload manually for:",
          transfer.id
        );
        transfer.status = "active";
        transfer._resuming = false; // Reset flag
        this.renderTransfers();
        setTimeout(() => {
          this.uploadLoop(transfer);
        }, 50);
      }
    }, 2000);
  }

  stopTransfer(transfer) {
    if (transfer.type === "upload") {
      // Đặt trạng thái stopped và dừng loop ngay lập tức
      transfer.status = "stopped";
      transfer._stopCurrentLoop = true; // Dừng upload loop ngay lập tức
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

    if (pendingList.length > 0 && active === 0) {
      this.showNotification(
        `Bắt đầu upload đồng thời tối đa ${this.maxConcurrentUploads} files`,
        "info"
      );
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
  new FlexTransferHub();
});

// Export for potential module usage
if (typeof module !== "undefined" && module.exports) {
  module.exports = FlexTransferHub;
}
