import { meta } from './meta.ts';
import { project } from './project.ts';
import { repository } from './repository.ts';
import { mergeRequest } from './merge_request.ts';
import { discussion } from './discussion.ts';

/**
 * Core entities. Code-declared tools, as opposed to the JSON-declared plugins in tools.d/.
 * Order matters only for readability: duplicate names are a bug, and the JSON layer is
 * merged last so a declaration can override a built-in deliberately.
 */
export const entities = [meta, project, repository, mergeRequest, discussion];
