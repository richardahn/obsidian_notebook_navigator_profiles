import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
  normalizePath
} from "obsidian";

interface ProfileMetadata {
  id: string;
  name: string;
  filename: string;
  createdAt: number;
  updatedAt: number;
}

interface BackupMetadata {
  createdAt: number;
  sourceProfileId: string | null;
  sourceProfileName: string | null;
}

interface NotebookNavigatorProfilesSettings {
  profileDirectory: string;
  profiles: ProfileMetadata[];
  backup: BackupMetadata | null;
}

const DEFAULT_SETTINGS: NotebookNavigatorProfilesSettings = {
  profileDirectory: "profiles",
  profiles: [],
  backup: null
};

const NOTEBOOK_NAVIGATOR_PLUGIN_ID = "notebook-navigator";
const NOTEBOOK_NAVIGATOR_DATA_BASENAME = "data.json";

export default class NotebookNavigatorProfilesPlugin extends Plugin {
  settings: NotebookNavigatorProfilesSettings;
  private registeredCommandIds = new Set<string>();
  private settingTab?: NotebookNavigatorProfilesSettingTab;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureStorageFolder();
    await this.pruneMissingProfiles();
    await this.pruneMissingBackup();

    this.settingTab = new NotebookNavigatorProfilesSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerProfileCommands();

    this.addCommand({
      id: "create-profile-from-current",
      name: "Create profile from current Notebook Navigator configuration",
      callback: () => this.openCreateProfileModal()
    });
  }

  onunload(): void {
    this.clearProfileCommands();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<NotebookNavigatorProfilesSettings> | null;
    const profiles = Array.isArray(loaded?.profiles) ? loaded?.profiles.filter(isProfileMetadata) : [];
    const backup = isBackupMetadata(loaded?.backup) ? sanitizeBackupMetadata(loaded?.backup) : null;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      profileDirectory: this.normalizeRelativeDirectory(loaded?.profileDirectory ?? DEFAULT_SETTINGS.profileDirectory),
      profiles: profiles.map((profile) => ({
        ...profile,
        createdAt: profile.createdAt ?? Date.now(),
        updatedAt: profile.updatedAt ?? profile.createdAt ?? Date.now()
      })),
      backup
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async createProfile(name: string): Promise<void> {
    await this.ensureStorageFolder();

    const uniqueName = this.ensureUniqueProfileName(name.trim() || this.generateDefaultProfileName());
    const metadata = this.createProfileMetadata(uniqueName);

    const notebookNavigatorData = await this.readNotebookNavigatorData();
    await this.app.vault.adapter.write(this.resolveProfilePath(metadata.filename), notebookNavigatorData);

    this.settings.profiles.push(metadata);
    await this.finalizeProfileMutation();
    new Notice(`Profile "${metadata.name}" created.`);
  }

  async activateProfile(profileId: string): Promise<void> {
    const profile = this.getProfileById(profileId);
    if (!profile) {
      throw new Error("Profile not found.");
    }

    await this.ensureStorageFolder();

    const currentData = await this.readNotebookNavigatorData();
    await this.createBackup(currentData, profile);

    const profileData = await this.readProfileData(profile);
    await this.writeNotebookNavigatorData(profileData);

    profile.updatedAt = Date.now();
    await this.saveSettings();
    this.requestSettingsReload();
    new Notice(`Profile "${profile.name}" activated.`);
  }

  async updateProfile(profileId: string): Promise<void> {
    await this.ensureStorageFolder();

    const profile = this.getProfileById(profileId);
    if (!profile) {
      throw new Error("Profile not found.");
    }

    const notebookNavigatorData = await this.readNotebookNavigatorData();
    await this.app.vault.adapter.write(this.resolveProfilePath(profile.filename), notebookNavigatorData);

    profile.updatedAt = Date.now();
    await this.finalizeProfileMutation({ skipCommandRefresh: true });
    new Notice(`Profile "${profile.name}" updated from current configuration.`);
  }

  async renameProfile(profileId: string, proposedName: string): Promise<void> {
    await this.ensureStorageFolder();

    const profile = this.getProfileById(profileId);
    if (!profile) {
      throw new Error("Profile not found.");
    }

    const trimmed = proposedName.trim();
    if (!trimmed.length) {
      throw new Error("Profile name cannot be empty.");
    }

    const uniqueName = this.ensureUniqueProfileName(trimmed, profileId);
    const newFilename = this.ensureUniqueFilename(`${this.sanitizeFileName(uniqueName)}.json`, profileId);

    const adapter = this.app.vault.adapter;
    const previousPath = this.resolveProfilePath(profile.filename);
    const nextPath = this.resolveProfilePath(newFilename);

    if (previousPath !== nextPath) {
      await adapter.rename(previousPath, nextPath);
    }

    profile.name = uniqueName;
    profile.filename = newFilename;
    profile.updatedAt = Date.now();

    await this.finalizeProfileMutation();
    new Notice(`Profile renamed to "${profile.name}".`);
  }

  async deleteProfile(profileId: string): Promise<void> {
    const profile = this.getProfileById(profileId);
    if (!profile) {
      throw new Error("Profile not found.");
    }

    const path = this.resolveProfilePath(profile.filename);
    const stat = await this.app.vault.adapter.stat(path).catch(() => null);
    if (stat) {
      await this.app.vault.adapter.remove(path);
    }

    this.settings.profiles = this.settings.profiles.filter((entry) => entry.id !== profileId);
    await this.finalizeProfileMutation();
    new Notice(`Profile "${profile.name}" deleted.`);
  }

  openCreateProfileModal(): void {
    new ProfileNameModal(this.app, {
      title: "Create Notebook Navigator profile",
      submitLabel: "Create",
      defaultValue: this.generateDefaultProfileName(),
      description: "Save the current Notebook Navigator configuration as a reusable profile.",
      onSubmit: async (value) => {
        await this.runProfileOperation(() => this.createProfile(value), "Unable to create profile.");
      }
    }).open();
  }

  async runProfileOperation(action: () => Promise<void>, failureMessage: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.handleError(error, failureMessage);
      throw error;
    }
  }

  async confirmProfileDeletion(profile: ProfileMetadata): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmationModal(this.app, {
        title: `Delete profile ${profile.name}?`,
        message: `Deleting this profile will remove the saved Notebook Navigator configuration file "${profile.filename}".`,
        detail: "This action cannot be undone.",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true,
        onResult: resolve
      });
      modal.open();
    });
  }

  requestSettingsReload(): void {
    this.settingTab?.display();
  }

  private async pruneMissingProfiles(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const existing: ProfileMetadata[] = [];
    const missing: ProfileMetadata[] = [];

    for (const profile of this.settings.profiles) {
      const stat = await adapter.stat(this.resolveProfilePath(profile.filename)).catch(() => null);
      if (stat?.type === "file") {
        existing.push(profile);
      } else {
        missing.push(profile);
      }
    }

    if (missing.length > 0) {
      this.settings.profiles = existing;
      await this.saveSettings();
      new Notice(`Removed ${missing.length} missing Notebook Navigator profile${missing.length === 1 ? "" : "s"}.`);
    }
  }

  private async pruneMissingBackup(): Promise<void> {
    if (!this.settings.backup) {
      return;
    }

    const adapter = this.app.vault.adapter;
    const stat = await adapter.stat(this.getBackupFilePath()).catch(() => null);
    if (!stat || stat.type !== "file") {
      this.settings.backup = null;
      await this.saveSettings();
    }
  }

  private getProfileById(profileId: string): ProfileMetadata | undefined {
    return this.settings.profiles.find((profile) => profile.id === profileId);
  }

  private async finalizeProfileMutation(options: { skipCommandRefresh?: boolean } = {}): Promise<void> {
    await this.saveSettings();
    if (!options.skipCommandRefresh) {
      this.registerProfileCommands();
    }
    this.requestSettingsReload();
  }

  async revertBackup(): Promise<void> {
    if (!this.settings.backup) {
      throw new Error("No backup is currently stored.");
    }

    const adapter = this.app.vault.adapter;
    const path = this.getBackupFilePath();

    let backupData: string;
    try {
      backupData = await adapter.read(path);
    } catch (error) {
      this.settings.backup = null;
      await this.saveSettings();
      this.requestSettingsReload();
      throw new Error("Backup file not found. The backup reference has been cleared.");
    }

    await this.writeNotebookNavigatorData(backupData);
    await this.saveSettings();
    this.requestSettingsReload();
    new Notice("Notebook Navigator configuration restored from backup.");
  }

  private registerProfileCommands(): void {
    this.clearProfileCommands();

    for (const profile of this.settings.profiles) {
      const command = this.addCommand({
        id: `activate-profile-${profile.id}`,
        name: `Activate profile ${profile.name}`,
        callback: () =>
          this.runProfileOperation(() => this.activateProfile(profile.id), `Unable to activate "${profile.name}".`)
      });

      this.registeredCommandIds.add(command.id);
    }
  }

  private clearProfileCommands(): void {
    for (const commandId of this.registeredCommandIds) {
      this.app.commands.removeCommand(commandId);
    }
    this.registeredCommandIds.clear();
  }

  private async ensureStorageFolder(): Promise<void> {
    await this.ensureFolder(this.getPluginBasePath());
    await this.ensureFolder(this.getProfileDirectoryPath());
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const stat = await adapter.stat(path).catch(() => null);
    if (!stat) {
      await adapter.mkdir(path);
      return;
    }
    if (stat.type !== "folder") {
      throw new Error(`Expected folder at ${path} but found a file.`);
    }
  }

  private getPluginBasePath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
  }

  private getProfileDirectoryPath(): string {
    return normalizePath(`${this.getPluginBasePath()}/${this.settings.profileDirectory}`);
  }

  private resolveProfilePath(filename: string): string {
    return normalizePath(`${this.getProfileDirectoryPath()}/${filename}`);
  }

  private getBackupFilePath(): string {
    return normalizePath(`${this.getPluginBasePath()}/backup.json`);
  }

  private getNotebookNavigatorDataPath(): string {
    return normalizePath(
      `${this.app.vault.configDir}/plugins/${NOTEBOOK_NAVIGATOR_PLUGIN_ID}/${NOTEBOOK_NAVIGATOR_DATA_BASENAME}`
    );
  }

  private async readNotebookNavigatorData(): Promise<string> {
    const path = this.getNotebookNavigatorDataPath();
    try {
      return await this.app.vault.adapter.read(path);
    } catch (error) {
      throw new Error(
        `Unable to read Notebook Navigator configuration at ${path}. ` +
          "Ensure the Notebook Navigator plugin is installed and has created its configuration file."
      );
    }
  }

  private async writeNotebookNavigatorData(content: string): Promise<void> {
    const path = this.getNotebookNavigatorDataPath();
    await this.app.vault.adapter.write(path, content);
  }

  private async readProfileData(profile: ProfileMetadata): Promise<string> {
    const path = this.resolveProfilePath(profile.filename);
    try {
      return await this.app.vault.adapter.read(path);
    } catch (error) {
      throw new Error(`Unable to read profile data at ${path}. The file may have been moved or deleted.`);
    }
  }

  private async createBackup(content: string, sourceProfile?: ProfileMetadata): Promise<void> {
    const adapter = this.app.vault.adapter;
    await adapter.write(this.getBackupFilePath(), content);
    this.settings.backup = {
      createdAt: Date.now(),
      sourceProfileId: sourceProfile?.id ?? null,
      sourceProfileName: sourceProfile?.name ?? null
    };
  }

  private ensureUniqueProfileName(baseName: string, excludeId?: string): string {
    const sanitizedBase = baseName.trim() || this.generateDefaultProfileName();
    const existingNames = new Set(
      this.settings.profiles.filter((profile) => profile.id !== excludeId).map((profile) => profile.name.toLowerCase())
    );

    let candidate = sanitizedBase;
    let index = 2;
    while (existingNames.has(candidate.toLowerCase())) {
      candidate = `${sanitizedBase} (${index++})`;
    }

    return candidate;
  }

  private ensureUniqueFilename(baseFilename: string, excludeId?: string): string {
    const existingFilenames = new Set(
      this.settings.profiles
        .filter((profile) => profile.id !== excludeId)
        .map((profile) => profile.filename.toLowerCase())
    );

    const parsed = this.splitFilename(baseFilename);
    let candidate = `${parsed.stem}${parsed.extension}`;
    let index = 2;
    while (existingFilenames.has(candidate.toLowerCase())) {
      candidate = `${parsed.stem}-${index++}${parsed.extension}`;
    }

    return candidate;
  }

  private createProfileMetadata(name: string): ProfileMetadata {
    const id = this.createUniqueId(name);
    const filename = this.ensureUniqueFilename(`${this.sanitizeFileName(name)}.json`);
    const timestamp = Date.now();
    return {
      id,
      name,
      filename,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private createUniqueId(name: string): string {
    const base = this.slugify(name) || "profile";
    const existingIds = new Set(this.settings.profiles.map((profile) => profile.id));

    let candidate = base;
    let index = 2;
    while (existingIds.has(candidate)) {
      candidate = `${base}-${index++}`;
    }

    return candidate;
  }

  private sanitizeFileName(value: string): string {
    const slug = this.slugify(value);
    return slug.length > 0 ? slug : "profile";
  }

  private slugify(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
  }

  private splitFilename(filename: string): { stem: string; extension: string } {
    const index = filename.lastIndexOf(".");
    if (index === -1) {
      return { stem: filename, extension: "" };
    }
    return { stem: filename.slice(0, index), extension: filename.slice(index) };
  }

  private generateDefaultProfileName(): string {
    return `Profile ${this.settings.profiles.length + 1}`;
  }

  private normalizeRelativeDirectory(relative: string): string {
    const trimmed = (relative ?? "").trim();
    const normalized = trimmed.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
    return normalized.length > 0 ? normalized : DEFAULT_SETTINGS.profileDirectory;
  }

  private handleError(error: unknown, userMessage: string): void {
    const details = error instanceof Error ? error.message : String(error);
    console.error("[Notebook Navigator Profiles]", details, error);
    new Notice(`${userMessage}\n${details}`);
  }
}

class NotebookNavigatorProfilesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NotebookNavigatorProfilesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Notebook Navigator Profiles" });

    new Setting(containerEl)
      .setName("Save current configuration as profile")
      .setDesc("Capture the existing Notebook Navigator settings into a reusable profile.")
      .addButton((button) =>
        button
          .setButtonText("Create Profile")
          .setCta()
          .onClick(() => this.plugin.openCreateProfileModal())
      );

    containerEl.createEl("h3", { text: "Saved profiles" });

    if (this.plugin.settings.profiles.length === 0) {
      containerEl.createEl("p", {
        text: "No profiles saved yet. Create one from the current Notebook Navigator configuration."
      });
      return;
    }

    for (const profile of this.plugin.settings.profiles) {
      const profileSetting = new Setting(containerEl)
        .setName(profile.name)
        .setDesc(`Stored as ${profile.filename}`);

      profileSetting.addButton((button) =>
        this.bindButton(button, "Activate", true, () =>
          this.plugin.runProfileOperation(
            () => this.plugin.activateProfile(profile.id),
            `Unable to activate "${profile.name}".`
          )
        )
      );

      profileSetting.addButton((button) =>
        this.bindButton(button, "Update", false, () =>
          this.plugin.runProfileOperation(
            () => this.plugin.updateProfile(profile.id),
            `Unable to update "${profile.name}".`
          )
        )
      );

      profileSetting.addButton((button) =>
        button
          .setButtonText("Rename")
          .onClick(() => {
            new ProfileNameModal(this.app, {
              title: `Rename "${profile.name}"`,
              submitLabel: "Rename",
              defaultValue: profile.name,
              description: "Update the label shown in the profile list and command palette.",
              onSubmit: async (value) => {
                await this.plugin.runProfileOperation(
                  () => this.plugin.renameProfile(profile.id, value),
                  `Unable to rename "${profile.name}".`
                );
              }
            }).open();
          })
      );

      profileSetting.addButton((button) => {
        button.setWarning();
        return this.bindButton(button, "Delete", false, async () => {
          const confirmed = await this.plugin.confirmProfileDeletion(profile);
          if (!confirmed) {
            return;
          }
          await this.plugin.runProfileOperation(
            () => this.plugin.deleteProfile(profile.id),
            `Unable to delete "${profile.name}".`
          );
        });
      });
    }

    if (this.plugin.settings.backup) {
      containerEl.createEl("h3", { text: "Backup" });

      const backupSetting = new Setting(containerEl)
        .setName("Restore previous configuration")
        .setDesc(this.formatBackupDescription(this.plugin.settings.backup));

      backupSetting.addButton((button) =>
        this.bindButton(button, "Restore backup", true, () =>
          this.plugin.runProfileOperation(
            () => this.plugin.revertBackup(),
            "Unable to restore backup."
          )
        )
      );
    }
  }

  private bindButton(
    button: ButtonComponent,
    label: string,
    isCta: boolean,
    action: () => Promise<void>
  ): ButtonComponent {
    button.setButtonText(label);
    if (isCta) {
      button.setCta();
    }
    button.onClick(async () => {
      if (button.buttonEl.hasAttribute("disabled")) {
        return;
      }

      const originalText = button.buttonEl.textContent ?? label;
      button.setDisabled(true);
      button.setButtonText(`${label}...`);

      try {
        await action();
      } finally {
        button.setDisabled(false);
        button.setButtonText(originalText);
      }
    });

    return button;
  }

  private formatBackupDescription(backup: BackupMetadata): string {
    const capturedAt = new Date(backup.createdAt).toLocaleString();
    if (backup.sourceProfileName) {
      return `Captured from profile "${backup.sourceProfileName}" on ${capturedAt}. Restoring will replace the current Notebook Navigator configuration.`;
    }
    return `Captured before activating a profile on ${capturedAt}. Restoring will replace the current Notebook Navigator configuration.`;
  }
}

interface ConfirmationModalOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onResult: (confirmed: boolean) => void;
}

class ConfirmationModal extends Modal {
  private resolved = false;

  constructor(app: App, private readonly options: ConfirmationModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const container = contentEl.createDiv({ cls: "nbnp-confirm-modal" });
    container.createEl("h2", { text: this.options.title });

    container.createEl("p", {
      text: this.options.message,
      cls: "nbnp-confirm-modal__message"
    });

    if (this.options.detail) {
      container.createEl("p", {
        text: this.options.detail,
        cls: "nbnp-confirm-modal__detail"
      });
    }

    const actions = container.createDiv({ cls: "nbnp-confirm-modal__actions" });

    const cancelButton = actions.createEl("button", {
      text: this.options.cancelLabel ?? "Cancel",
      attr: { type: "button" }
    });
    cancelButton.addEventListener("click", () => {
      this.resolve(false);
      this.close();
    });

    const confirmButton = actions.createEl("button", {
      text: this.options.confirmLabel,
      attr: { type: "button" }
    });
    confirmButton.classList.add(this.options.destructive ? "mod-warning" : "mod-cta");
    confirmButton.addEventListener("click", () => {
      this.resolve(true);
      this.close();
    });
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolve(false);
    }
  }

  private resolve(result: boolean): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.options.onResult(result);
  }
}

interface ProfileNameModalOptions {
  title: string;
  submitLabel: string;
  defaultValue?: string;
  description?: string;
  onSubmit: (value: string) => Promise<void>;
}

class ProfileNameModal extends Modal {
  private nameComponent!: TextComponent;
  private submitting = false;
  private submitButton?: HTMLButtonElement;

  constructor(app: App, private readonly options: ProfileNameModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const formEl = contentEl.createEl("form", { cls: "nbnp-profile-modal" });
    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });

    formEl.createEl("h2", { text: this.options.title });

    if (this.options.description) {
      formEl.createEl("p", {
        text: this.options.description,
        cls: "nbnp-profile-modal__description"
      });
    }

    new Setting(formEl)
      .setName("Profile name")
      .setDesc("This label appears in the Notebook Navigator Profiles list and command palette.")
      .addText((text) => {
        this.nameComponent = text;
        text.setPlaceholder("Example: Daily planning");
        if (this.options.defaultValue) {
          text.setValue(this.options.defaultValue);
          window.setTimeout(() => {
            text.inputEl.select();
          }, 0);
        } else {
          window.setTimeout(() => {
            text.inputEl.focus();
          }, 0);
        }
      });

    const actions = formEl.createDiv({ cls: "nbnp-profile-modal__actions" });
    this.submitButton = actions.createEl("button", {
      text: this.options.submitLabel,
      attr: { type: "submit" },
      cls: "mod-cta"
    });
    actions
      .createEl("button", { text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
  }

  private async submit(): Promise<void> {
    if (this.submitting) {
      return;
    }

    const value = this.nameComponent?.getValue().trim() ?? "";
    if (value.length === 0) {
      new Notice("Profile name cannot be empty.");
      this.nameComponent.inputEl.focus();
      return;
    }

    this.submitting = true;
    this.submitButton?.setAttribute("disabled", "true");
    this.submitButton?.classList.add("is-loading");

    try {
      await this.options.onSubmit(value);
      this.close();
    } catch {
      // Errors are reported by the caller.
    } finally {
      this.submitting = false;
      this.submitButton?.removeAttribute("disabled");
      this.submitButton?.classList.remove("is-loading");
    }
  }
}

function isProfileMetadata(value: unknown): value is ProfileMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.filename === "string"
  );
}

function isBackupMetadata(value: unknown): value is Partial<BackupMetadata> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.createdAt === "number";
}

function sanitizeBackupMetadata(raw: Partial<BackupMetadata> | undefined | null): BackupMetadata {
  const createdAt = typeof raw?.createdAt === "number" ? raw.createdAt : Date.now();
  const sourceProfileId = typeof raw?.sourceProfileId === "string" ? raw.sourceProfileId : null;
  const sourceProfileName = typeof raw?.sourceProfileName === "string" ? raw.sourceProfileName : null;
  return {
    createdAt,
    sourceProfileId,
    sourceProfileName
  };
}
