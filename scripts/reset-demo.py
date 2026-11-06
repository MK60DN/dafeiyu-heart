import sqlite3

DB = r"D:\Tender\Tender-Product\agent_layer\tender_agent.db"
con = sqlite3.connect(DB)
n = con.execute("delete from events where student_id = ?", ("dafeiyu",)).rowcount
con.commit()
left = con.execute("select count(*) from events where student_id = ?", ("dafeiyu",)).fetchone()[0]
print(f"deleted={n} remaining={left}")
con.close()
