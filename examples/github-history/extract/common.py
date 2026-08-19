"""Shared parquet writing for the extractors."""
import os

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

UTC = pa.timestamp("us", tz="UTC")


def to_table(rows):
    """Rows -> an arrow table with real timestamps.

    Every `*_at` column arrives as an ISO-8601 string (git writes an offset,
    the API writes `Z`). Casting them here is what lets the semantic model do
    `.month`, `.year`, and time arithmetic instead of string wrangling.
    """
    table = pa.Table.from_pylist(rows)
    for i, field in enumerate(table.schema):
        target = None
        if field.name.endswith("_at") and (
            pa.types.is_string(field.type) or pa.types.is_null(field.type)
        ):
            target = UTC
        elif pa.types.is_null(field.type):
            # A column that happened to be empty in this run -- pin it to a
            # usable type so the schema does not shift once it fills in.
            target = pa.string()
        elif pa.types.is_list(field.type) and pa.types.is_null(field.type.value_type):
            target = pa.list_(pa.string())
        if target is not None:
            table = table.set_column(
                i, pa.field(field.name, target), pc.cast(table.column(i), target)
            )
    return table


def write(rows, path):
    table = to_table(rows)
    pq.write_table(table, path, compression="zstd")
    print(f"  {os.path.basename(path):22} {table.num_rows:>7,} rows  "
          f"{os.path.getsize(path)/1024:>8.1f} KiB")
    return table
