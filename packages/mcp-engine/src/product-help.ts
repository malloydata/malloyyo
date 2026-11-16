// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// malloyyo's own yo_help topics (dashboards, repos, sites, the authoring loop),
// added to the index by the full engine entry (src/index.ts). The core entry
// (src/core.ts) leaves them out.

import { productContentFiles } from './content/generated-product';
import { addHelpContent } from './help';

addHelpContent(productContentFiles);
