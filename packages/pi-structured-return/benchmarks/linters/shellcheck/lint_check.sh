#!/bin/bash

greeting="hello world"
echo $greeting

for f in $(ls *.txt); do
    cat $f
done
