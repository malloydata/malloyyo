// Instructions handed to the model when it writes Malloy queries.
//
// This is a plain template literal (TypeScript's version of a "here document"):
// edit the text freely between the backticks. The only character you need to
// escape is a backtick (`` \` ``) or a literal `${` sequence.
export const QUERY_INSTRUCTIONS = `
// Basic Malloy query structure, ALWAYS uses 'group_by' instead of select
run: <source> -> {
  group_by: <dimension>
  aggregate: <measure>
  where: <condition>
  order_by: <measure> desc
}

// Refining a view or named query
run: <source> -> <view_name> + {
  where: color = 'red'
  order_by: <measure> desc
}

// Nested field access with dot notation
run: <source> -> {
  group_by: product.category.brand
  aggregate: <measure>
}
`;
