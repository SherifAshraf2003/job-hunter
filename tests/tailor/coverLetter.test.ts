import { test, expect } from "vitest";
import { signCoverLetter } from "@/tailor/generate";

test("replaces name placeholders with his name", () => {
  expect(signCoverLetter("Thanks.\n\nSincerely,\n[Your Name]", "Sherif Ashraf")).toBe("Thanks.\n\nSincerely,\nSherif Ashraf");
  expect(signCoverLetter("Best,\n[Full Name]", "Sherif Ashraf")).toBe("Best,\nSherif Ashraf");
});

test("adds a signature when the letter has none", () => {
  expect(signCoverLetter("Thanks for reading.", "Sherif Ashraf")).toBe("Thanks for reading.\n\nSherif Ashraf");
});

test("leaves a letter already signed with his name alone", () => {
  expect(signCoverLetter("Sincerely,\nSherif Ashraf", "Sherif Ashraf")).toBe("Sincerely,\nSherif Ashraf");
});
