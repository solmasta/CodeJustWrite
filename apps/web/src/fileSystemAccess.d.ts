// TypeScript's bundled DOM lib includes the base File System Access API shapes
// (FileSystemDirectoryHandle.getFileHandle, FileSystemFileHandle.createWritable, etc.) but not
// the permissions extension or window.showDirectoryPicker() — both are part of the same spec but
// still missing from lib.dom.d.ts as of this TypeScript version. Declared here rather than
// pulled from a @types package since none exists for just this gap.
export {};

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: "read" | "readwrite";
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface Window {
    showDirectoryPicker(options?: { id?: string; mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  }
}
