/** Hands the student a text file to keep. */
export type SaveFile = (name: string, text: string, type?: string) => void;

/** Saves through a temporary link, the way a page offers a download. Nothing is uploaded. */
export const browserSaveFile: SaveFile = (name, text, type = "application/json") => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The download has its own reference by now; the address is only good for this page.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
