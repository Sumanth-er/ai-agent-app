import os
import sys
import string
from datetime import datetime
from typing import List, Dict, Any
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor, as_completed

from pydantic import BaseModel, Field

from sqlalchemy import create_engine

from langchain_community.utilities import SQLDatabase
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from langchain_chroma import Chroma

from prompts import (
    sql_agent_prompt4,
    employee_prompt,
)

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
sys.path.append(os.path.join(BASE_DIR, "llm_gateway"))
from llm_models import LLM


# =============================================================================
# LLM INITIALIZATION
# =============================================================================

# Change model here if required.
# llm = LLM.nvidia_llm()
# llm = LLM.google_llm()
llm = LLM.ollama_ubuntu()

# input(llm.invoke("vanakam"))



# llm = LLM.nvidia_llm()

# Embedding model for Chroma
embeddings = LLM.nvidia_emb()


# =============================================================================
# SQLITE CONFIGURATION
# =============================================================================

SQLITE_DB_PATH = os.path.join(BASE_DIR, "eeee.db")
SQLITE_URI = f"sqlite:///{SQLITE_DB_PATH}"


# =============================================================================
# CHROMA CONFIGURATION
# =============================================================================

CHROMA_PERSIST_DIR = os.path.join(BASE_DIR, "chroma_db")

CHROMA_COLLECTION_NAME = "employee_master_data_collection"


# =============================================================================
# GLOBAL CONSTANTS
# =============================================================================

DISTINCT_VALUES_LIMIT = 5

TOP_K_RETRIEVAL = 5

MAX_SQL_RETRIES = 2


# =============================================================================
# DATABASE
# =============================================================================

def get_db(domain: str) -> SQLDatabase:
    """
    Returns SQLDatabase object for a specific table.
    """

    db = SQLDatabase.from_uri(
        SQLITE_URI,
        include_tables=[domain]
    )

    return db


# =============================================================================
# PROMPT FORMATTER
# =============================================================================

def safe_format_template(template: str, **kwargs) -> str:
    """
    Safely formats prompt templates.

    Missing placeholders are preserved instead of raising KeyError.

    Example:

        Hello {name}

    if name is not provided,

        Hello {name}

    will remain unchanged.
    """

    formatter = string.Formatter()

    fields = {
        field_name
        for _, field_name, _, _
        in formatter.parse(template)
        if field_name
    }

    values = {
        key: value
        for key, value
        in kwargs.items()
        if key in fields
    }

    class SafeDict(dict):
        def __missing__(self, key):
            return "{" + key + "}"

    return template.format_map(SafeDict(values))


# =============================================================================
# CURRENT DATE HELPERS
# =============================================================================

def get_current_context() -> Dict[str, str]:
    """
    Returns current date information used inside prompts.
    """

    now = datetime.now()

    return {
        "current_date": now.strftime("%B %d, %Y"),
        "current_month": now.strftime("%B"),
        "current_year": now.strftime("%Y"),
    }


# =============================================================================
# SQL CLEANER
# =============================================================================

def clean_sql(sql: str) -> str:
    """
    Removes markdown formatting returned by LLMs.

    Example:

    ```sql
    SELECT ...
    ```

    becomes

    SELECT ...
    """

    if sql is None:
        return ""

    sql = sql.replace("```sql", "")
    sql = sql.replace("```", "")

    return sql.strip()


# =============================================================================
# SIMPLE LOGGER
# =============================================================================

def log(title: str, value: Any):
    """
    Console logger for debugging.
    """

    print("\n" + "=" * 80)
    print(title)
    print("-" * 80)
    print(value)
    print("=" * 80)


# =============================================================================
# REPHRASE QUERY
# =============================================================================

class Rewriter(BaseModel):
    """
    Structured output returned by the query rewriter.
    """

    rewritten_query: str = Field(
        description="Clear rewritten version of the user query."
    )

    columns: List[str] = Field(
        # description="""Database columns that are likely needed.
        # along with that always include this columns details - Employee Number, Employee Name, Contact, Grade, 'refined_skill', 'Total Experience'"""
        description = "always use all the columns 'SELECT *' for employee such queries"
    )

    proper_nouns: List[str] = Field(
        description=(
            "refined_skill"
            "technologies or domain or skills"
        )
    )


# =============================================================================
# REPHRASE PROMPT
# =============================================================================

REPHRASE_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            """
You are an expert NLP Query Rewriter.

Your task is to rewrite employee database questions.

Database Knowledge:
{employee_prompt}

Return ONLY structured output.

Instructions:

1. Rewrite the user's query clearly.

2. Identify all columns required.

3. Extract all proper nouns that may require lookup.

Proper nouns include:

- Skills
- Locations

Examples

User:
Employees having langraph skill

Return

rewritten_query:
List employees having LangGraph skill.

columns:
[
"Employee Name",
"Skill"
]

proper_nouns:
[
"langraph"
]

-------------------------------------

User:
Who worked for TCS?

proper_nouns:
[
"TCS"
]

-------------------------------------

User:
Available Python developers in Hyderabad

proper_nouns:
[
"Python",
"Hyderabad"
]
"""
        ),
        (
            "human",
            "{question}"
        ),
    ]
)


# =============================================================================
# REPHRASE CHAIN
# =============================================================================

rewriter_llm = llm.with_structured_output(Rewriter)

rephrase_chain = (
    REPHRASE_PROMPT
    | rewriter_llm
)


# =============================================================================
# REPHRASE FUNCTION
# =============================================================================

def rephrase_query(
    query: str,
):
    """
    Rewrites user query into a structured format.

    Returns:

    rewritten_query

    columns

    proper_nouns
    """

    response = rephrase_chain.invoke(
        {
            "question": query,
            "employee_prompt": employee_prompt,
        }
    )

    log(
        "REWRITTEN QUERY",
        response.rewritten_query,
    )

    log(
        "COLUMNS",
        response.columns,
    )

    log(
        "PROPER NOUNS",
        response.proper_nouns,
    )

    return response

# =============================================================================
# CHROMA RETRIEVER
# =============================================================================

# def get_retriever():
#     """
#     Loads the persisted Chroma vector database.
#     """

#     vector_store = Chroma(
#         collection_name=CHROMA_COLLECTION_NAME,
#         embedding_function=embeddings,
#         persist_directory=CHROMA_PERSIST_DIR,
#     )

#     return vector_store.as_retriever(
#         search_kwargs={"k": TOP_K_RETRIEVAL}
#     )

from langchain_community.vectorstores import FAISS
from langchain_core.tools.retriever import create_retriever_tool


@lru_cache(maxsize=1)
def get_cached_retriever_tool():
    """
    Lazily load and cache the FAISS retriever tool in-process.
    This avoids reloading index files on every query.
    """
    return get_retriever(
        faiss_db_path=os.path.join(BASE_DIR, "faiss_db"),
        embeddings=embeddings,
        k=5,
    )


def get_retriever(
    faiss_db_path: str,
    embeddings,
    k: int = 5,
    tool_name: str = "search_proper_nouns",
    description: str = None,
):
    """
    Load a persisted FAISS vector store and return a retriever tool.
    """

    if description is None:
        description = (
            "Use to look up values to filter on. "
            "Input is an approximate spelling of a proper noun, "
            "output is valid proper nouns. Use the noun most "
            "similar to the search."
        )

    vector_store = FAISS.load_local(
        faiss_db_path,
        embeddings,
        allow_dangerous_deserialization=True,
    )

    retriever = vector_store.as_retriever(
        search_kwargs={"k": k}
    )

    retriever_tool = create_retriever_tool(
        retriever=retriever,
        name=tool_name,
        description=description,
    )

    return retriever_tool


# =============================================================================
# SEARCH PROPER NOUN
# =============================================================================

# def search_proper_noun(
#     value: str,
# ):
#     """
#     Returns the closest matching values from Chroma.

#     Example

#     Input

#         langraph

#     Output

#         [
#             "LangGraph",
#             "LangChain",
#             "GraphRAG"
#         ]
#     """

#     retriever = get_cached_retriever_tool()

#     try:

#         docs = retriever.invoke(value)

#         skills = [
#             skill.strip().rstrip(".")
#             for line in docs.splitlines()
#             if line.strip()
#             for skill in line.split(",")
#         ]

#         # print(skills)

#         # values = []

#         # for doc in docs:

#         #     text = doc.strip()

#         #     # if text and text not in values:
#         #     #     values.append(text)
#         #     values.append(text.lower())

#         # return values
#         # return list(docs)

#         return skills

#     except Exception as e:

#         print(e)

#         return []
def search_proper_noun(value : str):
    import sys
    sys.path.append("../sqllite_db_code/postgresdbb")
    from dbb import get_skill_candidates2, get_postgres_connection

    conn = get_postgres_connection()

    cursor = conn.cursor()

    return get_skill_candidates2(cursor, value, limit = 5)


# =============================================================================
# PROPER NOUN CORRECTION
# =============================================================================

def resolve_proper_nouns(
    proper_nouns: List[str],
):
    """
    Searches every extracted proper noun
    and returns the closest matches.
    """

    resolved = {}

    cleaned_nouns = [noun for noun in proper_nouns if str(noun).strip()]
    unique_nouns = list(dict.fromkeys(cleaned_nouns))

    if not unique_nouns:
        return resolved

    max_workers = min(8, len(unique_nouns))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_noun = {
            executor.submit(search_proper_noun, noun): noun
            for noun in unique_nouns
        }

        for future in as_completed(future_to_noun):
            noun = future_to_noun[future]
            try:
                resolved[noun] = future.result()
            except Exception:
                resolved[noun] = []

    # Preserve original order/duplicates behavior in output mapping.
    resolved = {noun: resolved.get(noun, []) for noun in cleaned_nouns}

    log(
        "PROPER NOUN MATCHES",
        resolved
    )

    return resolved


# =============================================================================
# BUILD SQL INPUT
# =============================================================================

def build_sql_question(
    rewritten_query: str,
    proper_noun_matches: Dict[str, List[str]],
):
    """
    Creates the final question that is sent
    to the SQL Generator.
    """

    question = rewritten_query

    if len(proper_noun_matches) == 0:
        return question

    question += "\n\n"

    question += "For skill comparison in the SQL query generation process, prioritize Closest Matches as the comparison criterion instead of the User Value.\nDetected Skills Matches:\n"

    for user_value, matches in proper_noun_matches.items():

        question += f"\nUser Value : {user_value}\n"

        if len(matches):

            question += "Closest Matches:\n"

            for item in matches:
                question += f"- {item}\n"

        else:

            question += "Closest Matches:\n"

            question += "- None\n"

    return question


# =============================================================================
# COMPLETE PREPROCESSING
# =============================================================================

def preprocess_query(
    query: str,
):
    """
    Complete preprocessing pipeline.

    User Query
            ↓
    Rephrase Query
            ↓
    Extract Proper Nouns
            ↓
    Chroma Search
            ↓
    Final SQL Question
    """

    rewritten = rephrase_query(query)

    # FIX: was hardcoded to the string "ram", which caused
    # 'str' object has no attribute 'items' inside build_sql_question().
    # Restored the actual Chroma-based resolution call.
    proper_noun_matches = resolve_proper_nouns(
        rewritten.proper_nouns
    )

    final_question = build_sql_question(
        rewritten_query=rewritten.rewritten_query,
        proper_noun_matches=proper_noun_matches,
    )

    log(
        "FINAL SQL QUESTION",
        final_question,
    )

    return {
        "question": final_question,
        "columns": rewritten.columns,
        "proper_nouns": proper_noun_matches,
    }
    
    
# =============================================================================
# SQL GENERATION
# =============================================================================

SQL_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "{system_prompt}",
        ),
        (
            "human",
            """
Question:

{question}

Relevant Columns:

{columns}

Schema : 

{Schema}

Generate ONLY one valid SQLite SQL query.
Return SQL only.
""",
        ),
    ]
)


sql_chain = (
    SQL_PROMPT
    | llm
    | StrOutputParser()
)


# =============================================================================
# BUILD SYSTEM PROMPT
# =============================================================================

def build_system_prompt():
    """
    Builds the SQL generation prompt.
    """

    context = get_current_context()

    return safe_format_template(
        # FIX: sql_agent_prompt3 was undefined (never imported) and
        # would raise a NameError. The actual imported template is
        # sql_agent_prompt4.
        template=sql_agent_prompt4,
        current_date=context["current_date"],
        current_month=context["current_month"],
        current_year=context["current_year"],
        dialect="sqlite",
        employee_prompt=employee_prompt,
        tool_names="Proper Noun Retriever",
    )


# =============================================================================
# GENERATE SQL
# =============================================================================



@lru_cache(maxsize=16)
def get_table_schema(domain: str) -> str:
    """
    Returns the schema of the specified table.
    """
    db = SQLDatabase.from_uri(
        SQLITE_URI,
        include_tables=[domain]
    )

    return db.get_table_info()

def generate_sql(
    query: str,
    domain: str
):
    """
    Complete NL → SQL generation.

    User Query
            ↓
    Rephrase
            ↓
    Chroma Search
            ↓
    SQL Generation
    """

    processed = preprocess_query(query)

    prompt = build_system_prompt()

    # FIX: removed a leftover debug call `input(prompt)` that was
    # blocking execution, waiting on manual console input.

    sql = sql_chain.invoke(
        {
            "system_prompt": prompt,
            "question": processed["question"],
            "columns": ", ".join(processed["columns"]),
            "Schema" : get_table_schema(domain)
        }
    )

    sql = clean_sql(sql)

    log(
        "GENERATED SQL",
        sql,
    )

    return sql
    
    
    
# =============================================================================
# SQL VALIDATION
# =============================================================================

FORBIDDEN_SQL = [
    "DROP",
    "DELETE",
    "UPDATE",
    "ALTER",
    "INSERT",
    "CREATE",
    "TRUNCATE",
    "REPLACE",
    "MERGE",
]


def validate_sql(sql: str):
    """
    Validates generated SQL before execution.
    """

    if not sql:
        raise ValueError("Generated SQL is empty.")

    sql_upper = sql.upper()

    # for keyword in FORBIDDEN_SQL:
    #     if keyword in sql_upper:
    #         raise ValueError(
    #             f"Unsafe SQL detected: {keyword}"
    #         )

    # if "SELECT *" in sql_upper:
    #     raise ValueError(
    #         "SELECT * is not allowed."
    #     )

    return True


# =============================================================================
# SQL EXECUTION
# =============================================================================

def execute_sql(
    domain: str,
    sql: str,
):
    """
    Executes SQL on SQLite.
    """

    validate_sql(sql)

    from sqlalchemy import text

    # db = get_db(domain)

    # with db._engine.connect() as conn:
    #     result = conn.execute(text(sql))

    #     columns = result.keys()  # column names

    #     rows = [
    #         dict(zip(columns, row))
    #         for row in result.fetchall()
    #     ]

    db = get_db(domain)

    with db._engine.connect() as conn:
        result = conn.execute(text(sql))

        columns = list(result.keys())

        rows = [
            [str(value) if value is not None else "" for value in row]
            for row in result.fetchall()
        ]

    return {
        "columns": columns,
        "rows": rows
    }

    # return rows


# =============================================================================
# SQL RETRY PROMPT
# =============================================================================

SQL_RETRY_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            """
You are an expert SQLite SQL Generator.

The SQL below failed.

Fix ONLY the SQL.

Return ONLY corrected SQL.

Do not explain anything.
"""
        ),
        (
            "human",
            """
Original Question:

{question}

Generated SQL:

{sql}

SQLite Error:

{error}
"""
        )
    ]
)

retry_chain = (
    SQL_RETRY_PROMPT
    | llm
    | StrOutputParser()
)


# =============================================================================
# EXECUTE WITH RETRY
# =============================================================================

def execute_with_retry(
    domain: str,
    question: str,
):
    """
    Complete execution pipeline.

    Generate SQL

        ↓

    Validate

        ↓

    Execute

        ↓

    Retry once if SQL fails
    """

    sql = generate_sql(question, domain)

    retries = 0

    while retries <= MAX_SQL_RETRIES:

        try:

            result = execute_sql(
                domain,
                sql,
            )

            log(
                "QUERY RESULT",
                result,
            )

            return {
                "success": True,
                "sql": sql,
                "result": result,
            }

        except Exception as e:

            log(
                "SQL ERROR",
                str(e),
            )

            retries += 1

            if retries > MAX_SQL_RETRIES:

                return {
                    "success": False,
                    "sql": sql,
                    "error": str(e),
                }

            sql = retry_chain.invoke(
                {
                    "question": question,
                    "sql": sql,
                    "error": str(e),
                }
            )

            sql = clean_sql(sql)

            log(
                "REGENERATED SQL",
                sql,
            )
            
# =============================================================================
# MAIN PIPELINE
# =============================================================================

def get_result(
    domain: str,
    query: str,
):
    """
    Main API.

    Pipeline

    User Query
            ↓
    Rephrase Query
            ↓
    Proper Noun Search
            ↓
    SQL Generation
            ↓
    SQL Validation
            ↓
    SQL Execution
            ↓
    Return Result
    """

    try:

        response = execute_with_retry(
            domain=domain,
            question=query,
        )

        return response

    except Exception as e:

        return {
            "success": False,
            "error": str(e),
        }


    # return { "success": True, "sql": """SELECT DISTINCT "Employee Number", "Employee Name"\nFROM employee_master_data\nWHERE\n (LOWER("Skill") LIKE '%python%' OR\n LOWER("Current Skillset") LIKE '%python%' OR\n LOWER("Primary Competency") LIKE '%python%' OR\n LOWER("Secondary Competency") LIKE '%python%')\n AND "Allocation Status" = 'Unallocated'\n AND "Available to take Project (Yes/No)" = 'Yes'\n AND "Relevant Exp" >= 3\nLIMIT 10;""", "result": {'columns': ['Employee Number', 'Employee Name', 'Skill'], 'rows': [['130785', 'Mr. Niloy Nibho Chaudhury', 'Data Architecture and Modeling [ E2 3 Yrs ], Digital : Apache Spark [ E1 3 Yrs ], Digital : Python [ E2 5 Yrs ]'], ['278554', 'Ms. Priya Ketan Lalan', 'Analytical Ability [ L2 <1 Yrs ], Digital : Data Science [ E0 5 Yrs ], Digital Banking [ E2 <1 Yrs ]'], ['464037', 'Mr. Pradeep Kumar Singaravelu', 'Windows Powershell [ E2 <1 Yrs ] ; Digital : Microsoft Azure [ E1 <1 Yrs ] ; Digital : Python [ E1 <1 Yrs ]'], ['531835', 'Ms. Vaddi Venkata Phanipavan Rajani', 'Automation Testing, Mainframe, Manual, PL, SQL, Selenium'], ['545243', 'Ms. Nidhi Jain', 'Digital : Microsoft Azure [ E1 4 Yrs ], Digital : Python [ E2 1 Yrs ], Digital : Snowflake [ E2 4 Yrs ]'], ['829437', 'Ms. Latha Kumari', 'Digital : HTML5-CSS3 [ E2 4 Yrs ], Digital : Python [ E0 3 Yrs ], Generative AI [ E1 4 Yrs ]'], ['1350446', 'Mr. Jhalak Dev Kumar', 'Agile Way of Working [ E1 1 Yrs ]'], ['1448104', 'Mr. Vishwanath Ss', 'AUTOMATION ANYWHERE, MANUAL TESTING, PYTHON DEVELOPMENT'], ['1646738', 'Mr. Abhinav Gupta', 'Digital : Python [ E1 4 Yrs ], Digital : Snowflake [ E1 3 Yrs ], PL, SQL [ E1 4 Yrs ]'], ['1796394', 'Mr. Parthiban V', 'CSS, DHTML, Linux Basics and Commands, SQL, XHTML, [Pri-E0-Asse]Cyber Security - Information Security, [Pri-E0-Asse]Digital : Internet of Things, [Pri-E0-Asse]Digital : Python, [Pri-E0-Asse]EIS : Embedded Digital Hardware Design and Development, [Pri-E0-Asse]HTML, [Pri-E0-Asse]OS Concepts, [Pri-E0-Asse]RDBMS Concepts, [Pri-E0-Asse]Unix, [Sec-E0-Asse]Core Java, [Sec-E0-Asse]Foundation : JavaScript, [Sec-E0-Asse]MySQL, [Sec-E0-Asse]ORACLE SQL, [Sec-E0-Asse]PL, [Sec-E0-Asse]Programming Techniques and Concepts, [Sec-E0-Asse]Unix Shell Scripting and text processing tools']]} }




# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":

    domain = "employee_master_data"

    # while True:

    print("\n")

    # query = input("Ask your question (type 'exit' to quit): ")
    query = "list all employees with experience above 4.5 and having ml skill"

    # if query.lower() in ["exit", "quit"]:

    #     break

    response = get_result(
        domain=domain,
        query=query,
    )

    print("\n")

    if response["success"]:

        print("=" * 80)
        print("GENERATED SQL")
        print("=" * 80)
        print(response["sql"])

        print("\n")

        print("=" * 80)
        print("RESULT")
        print("=" * 80)
        print(response["result"])
        print(len(response))

    else:

        print("=" * 80)
        print("ERROR")
        print("=" * 80)
        print(response["error"])

#     sql = """
# SELECT "Employee Number", "Employee Name", Skill FROM employee_master_data WHERE LOWER(Skill) LIKE '%python%' OR LOWER("Current Skillset") LIKE '%python%' OR LOWER("Primary Competency") LIKE '%python%' OR LOWER("Secondary Competency") LIKE '%python%' LIMIT 10;
# """
#     print(execute_sql(domain=domain, sql=sql))
