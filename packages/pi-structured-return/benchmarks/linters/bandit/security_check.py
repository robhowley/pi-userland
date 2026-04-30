import subprocess

user_input = input("Enter command: ")
subprocess.call(user_input, shell=True)
