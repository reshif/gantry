import { useProjectRepos } from "../floor/kit";

/** The display name of a repo of a project (its id until the repo read answers). */
export function useRepoName(project: string | null | undefined, repo: string | null | undefined): string {
  const repos = useProjectRepos(project);
  return repos.find((r) => r.id === repo)?.name ?? repo ?? "";
}
